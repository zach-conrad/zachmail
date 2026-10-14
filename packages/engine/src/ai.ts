import { triageThread, type Ai, type PromptMessage } from '@zachmail/ai'
import {
  enqueueJob,
  nudge,
  readThreadForAi,
  saveTriage,
  threadsNeedingTriage,
  type Db,
  type Queryable,
  type ThreadForAi,
} from '@zachmail/db/server'
import { htmlToText } from '@zachmail/mime'
import { mapLimit } from '@zachmail/providers'
import type { ProviderFactory } from './accounts'
import { getMessageBody } from './bodies'

export const AI_TRIAGE_JOB = 'ai.triage'

/** Threads per job run; the job re-queues itself while more are waiting (e.g. after backfill). */
const TRIAGE_BATCH = 25
const TRIAGE_CONCURRENCY = 5
const TRIAGE_MESSAGES = 3

/** Queues triage for an account's untriaged inbox threads; bursts of syncs coalesce. */
export const enqueueTriage = (db: Queryable, userId: string, accountId: string) =>
  enqueueJob(db, {
    userId,
    kind: AI_TRIAGE_JOB,
    payload: { accountId },
    dedupeKey: `triage:${accountId}`,
  })

const bodyText = (m: ThreadForAi['messages'][number]) =>
  m.bodyText?.trim() || (m.bodyHtml ? htmlToText(m.bodyHtml) : '') || m.snippet

export const promptMessages = (t: ThreadForAi): PromptMessage[] =>
  t.messages.map((m) => ({
    from: m.from,
    to: m.to,
    cc: m.cc,
    date: m.date,
    listUnsubscribe: m.listUnsubscribe,
    text: bodyText(m),
  }))

/**
 * Triages one batch of an account's inbox threads with Haiku and stores the results on the
 * threads. Uses cached bodies when the prefetch already has them, else snippets: triage
 * never waits on the provider.
 */
export async function triageAccount(
  db: Db,
  ai: Ai,
  account: { id: string; userId: string },
): Promise<{ triaged: number; more: boolean }> {
  const ids = await threadsNeedingTriage(db, account.id, TRIAGE_BATCH)
  let triaged = 0
  await mapLimit(ids, TRIAGE_CONCURRENCY, async (id) => {
    const t = await readThreadForAi(db, account.userId, id, TRIAGE_MESSAGES)
    if (!t || !t.messages.length) return
    const result = await triageThread(ai, {
      me: t.me.map((a) => a.email),
      subject: t.subject,
      messages: promptMessages(t),
    })
    await saveTriage(db, account.userId, id, t.watermark, result)
    if (result) triaged++
  })
  if (triaged) await nudge(db, account.userId)
  const more = ids.length === TRIAGE_BATCH
  if (more) await enqueueTriage(db, account.userId, account.id)
  return { triaged, more }
}

const ASSIST_MESSAGES = 20
/** Bodies fetched from the provider when not cached yet; older messages fall back to snippets. */
const ASSIST_FETCH = 5

/**
 * The thread as the writing assistant sees it, fetching the latest few bodies from the
 * provider when the prefetch has not cached them. Null when the thread isn't the user's.
 */
export async function threadForAssist(
  db: Db,
  providers: ProviderFactory,
  imageProxySecret: string,
  userId: string,
  threadId: string,
) {
  const t = await readThreadForAi(db, userId, threadId, ASSIST_MESSAGES)
  if (!t) return null
  const missing = t.messages.slice(-ASSIST_FETCH).filter((m) => !m.bodyCached)
  await mapLimit(missing, 4, async (m) => {
    const r = await getMessageBody(db, providers, imageProxySecret, userId, m.id).catch(() => null)
    if (r) m.bodyHtml = r.body.html
  })
  return { thread: t, messages: promptMessages(t) }
}
