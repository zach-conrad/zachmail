import type { Address, ThreadAi } from '@zachhub/core'
import type { Queryable } from './sql'
import { recordChanges } from './sync'

/** Inbox threads with mail newer than their last triage, newest first. */
export async function threadsNeedingTriage(
  db: Queryable,
  accountId: string,
  limit: number,
): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT t.id FROM threads t
     WHERE t.account_id = $1
       AND (t.ai_triaged_at IS NULL OR t.ai_triaged_at < t.last_message_at)
       AND EXISTS (SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
                   WHERE tf.thread_id = t.id AND f.kind = 'inbox')
     ORDER BY t.last_message_at DESC LIMIT $2`,
    [accountId, limit],
  )
  return rows.map((r) => r.id)
}

export interface ThreadForAi {
  id: string
  userId: string
  accountId: string
  subject: string
  /** The thread's last_message_at, verbatim, recorded as the triage watermark. */
  watermark: string
  /** The account's own addresses: primary plus send-as aliases. */
  me: Address[]
  messages: {
    id: string
    from: Address | null
    to: Address[]
    cc: Address[]
    date: number
    listUnsubscribe: boolean
    snippet: string
    bodyText: string | null
    bodyHtml: string | null
    bodyCached: boolean
  }[]
}

/** A thread and its latest `maxMessages` messages (oldest first), scoped to the user. */
export async function readThreadForAi(
  db: Queryable,
  userId: string,
  threadId: string,
  maxMessages: number,
): Promise<ThreadForAi | null> {
  const [t] = await db.query<{
    id: string
    account_id: string
    subject: string
    last: string
    email: string
    display_name: string | null
    send_as: Address[]
  }>(
    `SELECT t.id, t.account_id, t.subject, t.last_message_at::text AS last,
       a.email, a.display_name, a.send_as
     FROM threads t JOIN accounts a ON a.id = t.account_id
     WHERE t.id = $1 AND t.user_id = $2`,
    [threadId, userId],
  )
  if (!t) return null
  const messages = await db.query<ThreadForAi['messages'][number]>(
    `SELECT * FROM (
       SELECT m.id, m."from", m."to", m.cc, (extract(epoch FROM m.date) * 1000)::float8 AS date,
         m.list_unsubscribe IS NOT NULL AS "listUnsubscribe", m.snippet,
         b.text AS "bodyText", b.html AS "bodyHtml", b.message_id IS NOT NULL AS "bodyCached"
       FROM messages m LEFT JOIN message_bodies b ON b.message_id = m.id
       WHERE m.thread_id = $1 ORDER BY m.date DESC LIMIT $2
     ) x ORDER BY date`,
    [threadId, maxMessages],
  )
  return {
    id: t.id,
    userId,
    accountId: t.account_id,
    subject: t.subject,
    watermark: t.last,
    me: [{ email: t.email, ...(t.display_name ? { name: t.display_name } : {}) }, ...t.send_as],
    messages,
  }
}

/**
 * Stores a triage result as of `asOf` (the latest message it saw), so mail that lands while
 * Claude is thinking triggers another pass. `null` marks the thread done without a result
 * (declined or unusable output) so it is not retried until new mail arrives.
 */
export async function saveTriage(
  db: Queryable,
  userId: string,
  threadId: string,
  asOf: string,
  result: ThreadAi | null,
): Promise<void> {
  const rows = await db.query<{ id: string }>(
    `UPDATE threads SET ai_category = $3, ai_summary = $4, ai_needs_reply = $5,
       ai_triaged_at = $6::timestamptz, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [
      threadId,
      userId,
      result?.category ?? null,
      result?.summary ?? null,
      result?.needsReply ?? null,
      asOf,
    ],
  )
  if (result) await recordChanges(db, userId, 'thread', ids(rows), 'upsert')
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)
