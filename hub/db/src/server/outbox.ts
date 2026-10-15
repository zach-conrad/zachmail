import {
  DEFAULT_UNDO_MS,
  MAX_ATTACHMENT_BYTES,
  opEffect,
  sentMessageId,
  type Address,
  type FolderKind,
  type OpEffect,
  type OpEnvelope,
  type SendRequest,
} from '@zachhub/core'
import { enqueueWake } from './snooze'
import type { Db, Queryable } from './sql'
import { recomputeThreads, recordChanges } from './sync'
import { loadUploads } from './uploads'

/** Payload of a triage outbox row: thread and folder ids from our mirror. */
export interface TriagePayload extends OpEffect {
  threadIds: string[]
}

export interface AcceptResult {
  accepted: string[]
  rejected: { id: string; error: string }[]
  /** Accounts with new outbox rows, for the caller to enqueue a flush. */
  accounts: string[]
}

interface FolderRef {
  id: string
  accountId: string
  kind: FolderKind
  providerId: string
}

/**
 * Takes a batch of client ops: writes one outbox row per (op, account) and applies the same
 * effect to the mirror, so every other device sees the change on its next pull, before the
 * provider has been told. Replays of an op id are accepted without applying twice.
 */
export async function acceptOps(db: Db, userId: string, ops: OpEnvelope[]): Promise<AcceptResult> {
  return db.transaction((tx) => acceptOpsIn(tx, userId, ops))
}

/** Ops with no provider side: their outbox row is written already done. */
const LOCAL_ONLY = new Set(['remind', 'unremind'])

/** acceptOps inside a transaction the caller owns. */
export async function acceptOpsIn(
  tx: Queryable,
  userId: string,
  ops: OpEnvelope[],
): Promise<AcceptResult> {
  const result: AcceptResult = { accepted: [], rejected: [], accounts: [] }
  const accounts = new Set<string>()
  const folders = new Map<string, FolderRef[]>()

  for (const { id, op } of ops) {
    const threads = await tx.query<{ id: string; account_id: string }>(
      `SELECT id, account_id FROM threads WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [userId, op.threadIds],
    )
    if (!threads.length) {
      result.rejected.push({ id, error: 'Those conversations no longer exist' })
      continue
    }
    const byAccount = new Map<string, string[]>()
    for (const t of threads)
      byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.id])
    await loadFolders(tx, [...byAccount.keys()], folders)

    for (const [accountId, threadIds] of byAccount) {
      const own = folders.get(accountId) ?? []
      const ownIds = new Set(own.map((f) => f.id))
      const effect = opEffect(op, (kind) => own.find((f) => f.kind === kind)?.id)
      effect.add = effect.add.filter((f) => ownIds.has(f))
      effect.remove = effect.remove.filter((f) => ownIds.has(f))
      const payload: TriagePayload = { threadIds, ...effect }

      const local = LOCAL_ONLY.has(op.kind)
      const inserted = await tx.query(
        `INSERT INTO outbox (user_id, op_id, account_id, kind, payload, state)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (op_id, account_id) DO NOTHING RETURNING id`,
        [userId, id, accountId, op.kind, payload, local ? 'done' : 'pending'],
      )
      if (!inserted.length) continue
      if (!local) accounts.add(accountId)
      const touched = new Set<string>()
      ;(await applyZachmailState(tx, userId, accountId, id, threadIds, effect)).forEach((t) =>
        touched.add(t),
      )
      if (effect.snoozedUntil) await enqueueWake(tx, userId, effect.snoozedUntil)
      if (effect.reminder) await enqueueWake(tx, userId, effect.reminder.at)
      const hasProviderPart =
        effect.add.length ||
        effect.remove.length ||
        effect.unread !== undefined ||
        effect.starred !== undefined
      if (!hasProviderPart) {
        await recordChanges(tx, userId, 'thread', [...touched], 'upsert')
        continue
      }

      const provider = (ids: string[]) =>
        own.filter((f) => ids.includes(f.id)).map((f) => f.providerId)
      const changed = await tx.query<{ id: string }>(
        `WITH n AS (
           SELECT m.id, ARRAY(
             SELECT DISTINCT x FROM unnest(m.provider_labels || $2::text[]) AS x
             WHERE NOT (x = ANY($3::text[]))
           ) AS labels
           FROM messages m WHERE m.thread_id = ANY($1::uuid[])
         )
         UPDATE messages m SET provider_labels = n.labels,
           unread = COALESCE($4::boolean, m.unread), starred = COALESCE($5::boolean, m.starred),
           updated_at = now()
         FROM n WHERE m.id = n.id AND NOT (
           m.provider_labels @> n.labels AND n.labels @> m.provider_labels
           AND m.unread = COALESCE($4::boolean, m.unread)
           AND m.starred = COALESCE($5::boolean, m.starred))
         RETURNING m.id`,
        [
          threadIds,
          provider(effect.add),
          provider(effect.remove),
          effect.unread ?? null,
          effect.starred ?? null,
        ],
      )
      if (changed.length) {
        await recordChanges(
          tx,
          userId,
          'message',
          changed.map((m) => m.id),
          'upsert',
        )
        await recomputeThreads(tx, userId, threadIds)
        threadIds.forEach((t) => touched.add(t))
      }
      await recordChanges(tx, userId, 'thread', [...touched], 'upsert')
    }
    await recordChanges(tx, userId, 'op', [id], 'upsert')
    result.accepted.push(id)
  }
  result.accounts = [...accounts]
  return result
}

/** Writes an effect's ZachMail-only parts (mute, snooze, reminder); returns the threads that changed. */
async function applyZachmailState(
  tx: Queryable,
  userId: string,
  accountId: string,
  opId: string,
  threadIds: string[],
  effect: OpEffect,
): Promise<string[]> {
  const changed: string[] = []
  if (effect.muted !== undefined) {
    const rows = await tx.query<{ id: string }>(
      `UPDATE threads SET muted = $2, updated_at = now()
       WHERE id = ANY($1::uuid[]) AND muted <> $2 RETURNING id`,
      [threadIds, effect.muted],
    )
    changed.push(...rows.map((r) => r.id))
  }
  if (effect.snoozedUntil !== undefined) {
    const rows = await tx.query<{ id: string }>(
      `UPDATE threads SET snoozed_until = to_timestamp($2::float8 / 1000), updated_at = now()
       WHERE id = ANY($1::uuid[]) AND snoozed_until IS DISTINCT FROM to_timestamp($2::float8 / 1000)
       RETURNING id`,
      [threadIds, effect.snoozedUntil],
    )
    changed.push(...rows.map((r) => r.id))
  }
  if (effect.reminder === null) {
    const rows = await tx.query<{ id: string }>(
      `DELETE FROM reminders WHERE thread_id = ANY($1::uuid[]) RETURNING thread_id AS id`,
      [threadIds],
    )
    changed.push(...rows.map((r) => r.id))
  } else if (effect.reminder) {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO reminders (user_id, account_id, thread_id, op_id, remind_at, condition)
       SELECT $1, $2, t, $4, to_timestamp($5::float8 / 1000), $6::reminder_condition
       FROM unnest($3::uuid[]) AS t
       ON CONFLICT (thread_id) DO UPDATE SET op_id = excluded.op_id,
         remind_at = excluded.remind_at, condition = excluded.condition, created_at = now()
       RETURNING thread_id AS id`,
      [userId, accountId, threadIds, opId, effect.reminder.at, effect.reminder.condition],
    )
    changed.push(...rows.map((r) => r.id))
  }
  return changed
}

async function loadFolders(tx: Queryable, accountIds: string[], cache: Map<string, FolderRef[]>) {
  const missing = accountIds.filter((a) => !cache.has(a))
  if (!missing.length) return
  const rows = await tx.query<FolderRef>(
    `SELECT id, account_id AS "accountId", kind, provider_id AS "providerId"
     FROM folders WHERE account_id = ANY($1::uuid[])`,
    [missing],
  )
  for (const a of missing) cache.set(a, [])
  for (const f of rows) cache.get(f.accountId)!.push(f)
}

export interface OutboxItem {
  id: string
  opId: string
  userId: string
  accountId: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
}

/** An in-flight row older than this belongs to a dead worker and may be taken over. */
const STALE = `interval '2 minutes'`

/**
 * Claims the next row for an account. Rows run one at a time per account in `seq` order, so
 * an undo never overtakes the op it undoes. Sends waiting on `not_before` don't block the
 * line. Returns null when nothing is ready or another worker holds the account.
 */
export async function claimOutbox(db: Db, accountId: string): Promise<OutboxItem | null> {
  return db.transaction(async (tx) => {
    const [account] = await tx.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [
      accountId,
    ])
    if (!account) return null
    const [row] = await tx.query<OutboxItem>(
      `WITH head AS (
         SELECT id, state, not_before, locked_at FROM outbox
         WHERE account_id = $1 AND state IN ('pending', 'in_flight')
           AND (kind <> 'send' OR not_before <= now() OR state = 'in_flight')
         ORDER BY seq LIMIT 1
       )
       UPDATE outbox o SET state = 'in_flight', locked_at = now(), attempts = o.attempts + 1,
         updated_at = now()
       FROM head WHERE o.id = head.id AND (
         (head.state = 'pending' AND head.not_before <= now())
         OR (head.state = 'in_flight' AND head.locked_at < now() - ${STALE}))
       RETURNING o.id, o.op_id AS "opId", o.user_id AS "userId", o.account_id AS "accountId",
         o.kind, o.payload, o.attempts`,
      [accountId],
    )
    return row ?? null
  })
}

export type OutboxOutcome =
  | { state: 'done' }
  | { state: 'failed'; error: string }
  /** Transient failure: back to pending until `at`. */
  | { state: 'retry'; error: string; at: Date }

export async function finishOutbox(db: Db, item: OutboxItem, outcome: OutboxOutcome) {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE outbox SET state = $2, last_error = $3, locked_at = NULL, updated_at = now(),
         not_before = COALESCE($4::timestamptz, not_before)
       WHERE id = $1`,
      [
        item.id,
        outcome.state === 'retry' ? 'pending' : outcome.state,
        outcome.state === 'done' ? null : outcome.error,
        outcome.state === 'retry' ? outcome.at.toISOString() : null,
      ],
    )
    if (outcome.state !== 'retry') await recordChanges(tx, item.userId, 'op', [item.opId], 'upsert')
  })
}

/** Puts a claimed row back untouched (e.g. the account needs reauth). */
export async function releaseOutbox(db: Queryable, item: OutboxItem) {
  await db.query(
    `UPDATE outbox SET state = 'pending', locked_at = NULL, attempts = attempts - 1, updated_at = now()
     WHERE id = $1`,
    [item.id],
  )
}

/** Muted threads that new mail put back in the inbox; the caller archives them again. */
export async function mutedThreadsInInbox(db: Queryable, accountId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT t.id FROM threads t
     JOIN thread_folders tf ON tf.thread_id = t.id
     JOIN folders f ON f.id = tf.folder_id AND f.kind = 'inbox'
     WHERE t.account_id = $1 AND t.muted`,
    [accountId],
  )
  return rows.map((r) => r.id)
}

/** Accounts whose outbox has work nobody picked up (a lost job, a crashed worker). */
export async function stalledOutboxAccounts(db: Queryable) {
  return db.query<{ userId: string; accountId: string }>(
    `SELECT DISTINCT o.user_id AS "userId", o.account_id AS "accountId" FROM outbox o
     JOIN accounts a ON a.id = o.account_id AND a.status NOT IN ('needs_reauth', 'disabled')
     WHERE (o.state = 'pending' AND o.not_before < now() - interval '30 seconds')
        OR (o.state = 'in_flight' AND o.locked_at < now() - ${STALE})`,
  )
}

/** Payload of a send outbox row. */
export interface SendPayload {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  html: string
  replyToMessageId: string | null
  /** Upload ids. */
  attachments?: string[]
  /** Send payloads only: the draft to delete once sent. */
  draftId?: string | null
}

export class SendRejectedError extends Error {
  override name = 'SendRejectedError'
}

/**
 * Queues a message to send after the undo window (or at `sendAt`). Replays return the
 * original schedule.
 */
export async function acceptSend(db: Db, userId: string, req: SendRequest): Promise<number> {
  return db.transaction(async (tx) => {
    const [account] = await tx.query<{ email: string }>(
      `SELECT email FROM accounts WHERE id = $1 AND user_id = $2`,
      [req.accountId, userId],
    )
    if (!account) throw new SendRejectedError('No such account')
    let threadId: string | null = null
    if (req.replyToMessageId) {
      const [parent] = await tx.query<{ thread_id: string }>(
        `SELECT thread_id FROM messages WHERE id = $1 AND account_id = $2`,
        [req.replyToMessageId, req.accountId],
      )
      if (!parent) throw new SendRejectedError('The message being answered is gone')
      threadId = parent.thread_id
    }
    const files = await loadUploads(tx, userId, req.attachments ?? [])
    if (files.length !== (req.attachments ?? []).length)
      throw new SendRejectedError('An attachment is missing; upload it again')
    if (files.reduce((n, f) => n + f.size, 0) > MAX_ATTACHMENT_BYTES)
      throw new SendRejectedError('Attachments are too big to email together')
    const payload: SendPayload = {
      to: req.to,
      cc: req.cc ?? [],
      bcc: req.bcc ?? [],
      subject: req.subject,
      html: req.html,
      replyToMessageId: req.replyToMessageId ?? null,
      draftId: req.draftId ?? null,
      attachments: req.attachments ?? [],
    }
    const notBefore = Math.max(Date.now() + (req.undoMs ?? DEFAULT_UNDO_MS), req.sendAt ?? 0)
    const inserted = await tx.query<{ at: number }>(
      `INSERT INTO outbox (user_id, op_id, account_id, kind, payload, not_before)
       VALUES ($1, $2, $3, 'send', $4::jsonb, to_timestamp($5::float8 / 1000))
       ON CONFLICT (op_id, account_id) DO NOTHING
       RETURNING (extract(epoch FROM not_before) * 1000)::float8 AS at`,
      [userId, req.id, req.accountId, payload, notBefore],
    )
    if (inserted.length) {
      await recordChanges(tx, userId, 'op', [req.id], 'upsert')
      if (req.remindAt !== undefined) {
        // A new conversation has no thread yet; the sync that brings the sent copy in links it.
        await tx.query(
          `INSERT INTO reminders (user_id, account_id, thread_id, sent_message_id, op_id, remind_at)
           VALUES ($1, $2, $3, $4, $5, to_timestamp($6::float8 / 1000))
           ON CONFLICT (thread_id) DO UPDATE SET op_id = excluded.op_id,
             sent_message_id = excluded.sent_message_id, remind_at = excluded.remind_at,
             condition = excluded.condition, created_at = now()`,
          [
            userId,
            req.accountId,
            threadId,
            sentMessageId(req.id, account.email),
            req.id,
            req.remindAt,
          ],
        )
        if (threadId) await recordChanges(tx, userId, 'thread', [threadId], 'upsert')
        await enqueueWake(tx, userId, req.remindAt)
      }
      return inserted[0]!.at
    }
    const [existing] = await tx.query<{ at: number }>(
      `SELECT (extract(epoch FROM not_before) * 1000)::float8 AS at FROM outbox
       WHERE op_id = $1 AND user_id = $2 AND kind = 'send'`,
      [req.id, userId],
    )
    if (!existing) throw new SendRejectedError('That id is already used by another op')
    return existing.at
  })
}

/** Undo send: succeeds only while the worker hasn't started sending. Drops its reminder too. */
export async function cancelSend(db: Db, userId: string, opId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const gone = await tx.query(
      `DELETE FROM outbox WHERE op_id = $1 AND user_id = $2 AND kind = 'send' AND state = 'pending'
       RETURNING id`,
      [opId, userId],
    )
    if (!gone.length) return false
    const reminders = await tx.query<{ thread_id: string | null }>(
      `DELETE FROM reminders WHERE op_id = $1 AND user_id = $2 RETURNING thread_id`,
      [opId, userId],
    )
    const threads = reminders.flatMap((r) => (r.thread_id ? [r.thread_id] : []))
    await recordChanges(tx, userId, 'thread', threads, 'upsert')
    return true
  })
}
