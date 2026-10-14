import {
  applySyncBatch,
  claimOutbox,
  enqueueJob,
  finishOutbox,
  nudge,
  releaseOutbox,
  stalledOutboxAccounts,
  type Db,
  type OutboxItem,
  type SendPayload,
  type TriagePayload,
} from '@zachmail/db/server'
import { ProviderAuthError, ProviderError, type MailProvider } from '@zachmail/providers'
import { buildMime, replyReferences } from '@zachmail/mime'
import { sentMessageId } from '@zachmail/core'
import type { AccountRecord } from './accounts'

export const OUTBOX_JOB = 'outbox.flush'
const MAX_ATTEMPTS = 6

/** Retry delays: 2 s, 8 s, 32 s, ~2 min, ~8 min. */
export const outboxBackoffMs = (attempts: number) => 2_000 * 4 ** (attempts - 1)

export const enqueueOutboxFlush = (db: Db, userId: string, accountId: string, runAt?: Date) =>
  enqueueJob(db, {
    userId,
    kind: OUTBOX_JOB,
    payload: { accountId },
    // Timed flushes (retries, undo windows) get their own key so an earlier pending flush
    // can't swallow them.
    dedupeKey: runAt ? `outbox:${accountId}:${runAt.getTime()}` : `outbox:${accountId}`,
    runAt,
  })

/** Re-enqueues flushes nobody is running (lost jobs, crashed workers). Worker calls this. */
export async function sweepOutbox(db: Db) {
  for (const a of await stalledOutboxAccounts(db))
    await enqueueOutboxFlush(db, a.userId, a.accountId)
}

/**
 * Drains an account's outbox in order. Success leaves the optimistic mirror in place and
 * schedules a sync to confirm it; a permanent failure restores the threads from the provider
 * and marks the op failed so clients revert and say so.
 */
export async function flushOutbox(
  db: Db,
  account: AccountRecord,
  provider: MailProvider,
  enqueueSync: () => Promise<void>,
) {
  let applied = 0
  try {
    for (;;) {
      const item = await claimOutbox(db, account.id)
      if (!item) break
      try {
        await execute(db, item, provider)
        await finishOutbox(db, item, { state: 'done' })
        applied++
      } catch (err) {
        if (err instanceof ProviderAuthError) {
          await releaseOutbox(db, item)
          throw err
        }
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500)
        const retriable = !(err instanceof ProviderError) || err.retriable
        if (retriable && item.attempts < MAX_ATTEMPTS) {
          const at = new Date(Date.now() + outboxBackoffMs(item.attempts))
          await finishOutbox(db, item, { state: 'retry', error: message, at })
          await enqueueOutboxFlush(db, account.userId, account.id, at)
          break
        }
        await finishOutbox(db, item, { state: 'failed', error: message })
        await restore(db, account, item, provider)
        await nudge(db, account.userId)
      }
    }
  } finally {
    if (applied) {
      await nudge(db, account.userId)
      await enqueueSync()
    }
  }
}

async function execute(db: Db, item: OutboxItem, provider: MailProvider) {
  if (item.kind === 'send') return send(db, item, provider)
  const p = item.payload as unknown as TriagePayload
  const threads = await providerThreadIds(db, p.threadIds)
  if (!threads.length) return
  const folders = await db.query<{ id: string; provider_id: string }>(
    `SELECT id, provider_id FROM folders WHERE id = ANY($1::uuid[])`,
    [[...p.add, ...p.remove]],
  )
  const provider_ = (ids: string[]) =>
    folders.filter((f) => ids.includes(f.id)).map((f) => f.provider_id)
  await provider.apply(threads, {
    add: provider_(p.add),
    remove: provider_(p.remove),
    unread: p.unread,
    starred: p.starred,
  })
}

async function send(db: Db, item: OutboxItem, provider: MailProvider) {
  const p = item.payload as unknown as SendPayload
  const [account] = await db.query<{ email: string; display_name: string | null }>(
    `SELECT email, display_name FROM accounts WHERE id = $1`,
    [item.accountId],
  )
  if (!account) throw new ProviderError('The account was removed', false)
  const [parent] = p.replyToMessageId
    ? await db.query<{
        rfc822_message_id: string | null
        references: string[]
        provider_thread_id: string
      }>(
        `SELECT m.rfc822_message_id, m."references", t.provider_thread_id
         FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1`,
        [p.replyToMessageId],
      )
    : []
  const threading = parent
    ? replyReferences({ rfc822MessageId: parent.rfc822_message_id, references: parent.references })
    : { references: [] }
  const { raw } = buildMime(
    {
      from: {
        email: account.email,
        ...(account.display_name ? { name: account.display_name } : {}),
      },
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      html: p.html,
      // Stable per op, so a message that did go out can be recognised when it syncs back.
      messageId: sentMessageId(item.opId, account.email),
      ...threading,
    },
    { includeBcc: true },
  )
  await provider.send(raw, parent ? { providerThreadId: parent.provider_thread_id } : {})
}

const providerThreadIds = async (db: Db, ids: string[]) =>
  (
    await db.query<{ provider_thread_id: string }>(
      `SELECT provider_thread_id FROM threads WHERE id = ANY($1::uuid[])`,
      [ids],
    )
  ).map((t) => t.provider_thread_id)

/** Puts the threads back the way the provider has them. */
async function restore(db: Db, account: AccountRecord, item: OutboxItem, provider: MailProvider) {
  const ids = (item.payload as unknown as TriagePayload).threadIds ?? []
  try {
    const batch = await provider.fetchThreads(await providerThreadIds(db, ids))
    await applySyncBatch(db, { userId: account.userId, accountId: account.id, batch })
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'outbox restore failed', item: item.id, error: String(err) }),
    )
  }
}
