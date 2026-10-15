import { randomUUID } from 'node:crypto'
import type { OpEnvelope } from '@zachhub/core'
import { enqueueJob } from './jobs'
import { acceptOpsIn, type AcceptResult } from './outbox'
import type { Db, Queryable } from './sql'

/** Job kind that brings due snoozes and reminders back. */
export const WAKE_JOB = 'snooze.wake'

/** A compose reminder whose sent copy never synced back is dropped this long after it was due. */
const ORPHAN_AFTER = `interval '7 days'`

/**
 * Schedules a wake-up at `at` (epoch ms). Jobs at the same instant coalesce; the worker's
 * minute sweep catches anything a lost job would have missed.
 */
export const enqueueWake = (db: Queryable, userId: string, at: number) =>
  enqueueJob(db, {
    userId,
    kind: WAKE_JOB,
    dedupeKey: `wake:${userId}:${at}`,
    runAt: new Date(at),
  })

/**
 * SQL that is true when message `m` was written by someone other than account `a` (its
 * address or a send-as alias). A message with no From never counts as a reply.
 */
export const FROM_SOMEONE_ELSE = `(lower(m."from"->>'email') <> lower(a.email)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(a.send_as) s
                  WHERE lower(s->>'email') = lower(m."from"->>'email')))`

export interface WakeResult extends AcceptResult {
  userId: string
}

/**
 * Turns every due snooze and reminder into a server-issued op, through the same acceptOps
 * path as client ops: `unsnooze` (back to the inbox, unread) or, for an `if_no_reply`
 * reminder someone has answered, a quiet `unremind`. Due rows are locked with SKIP LOCKED in
 * the op's own transaction, so concurrent wakers never issue the same op twice.
 */
export async function wakeDue(db: Db, limit = 500): Promise<WakeResult[]> {
  return db.transaction(async (tx) => {
    const snoozed = await tx.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM threads WHERE snoozed_until <= now()
       ORDER BY snoozed_until LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    )
    // Compose reminders still waiting for their thread: give the sync a week, then drop them.
    await tx.query(
      `DELETE FROM reminders WHERE thread_id IS NULL AND remind_at < now() - ${ORPHAN_AFTER}`,
    )
    const reminders = await tx.query<{
      thread_id: string
      user_id: string
      fire: boolean
    }>(
      `SELECT r.thread_id, r.user_id,
         r.condition = 'always' OR NOT EXISTS (
           SELECT 1 FROM messages m JOIN accounts a ON a.id = m.account_id
           WHERE m.thread_id = r.thread_id AND m.date > r.created_at AND ${FROM_SOMEONE_ELSE}
         ) AS fire
       FROM reminders r WHERE r.remind_at <= now() AND r.thread_id IS NOT NULL
       ORDER BY r.remind_at LIMIT $1 FOR UPDATE OF r SKIP LOCKED`,
      [limit],
    )

    const byUser = new Map<string, OpEnvelope[]>()
    const add = (userId: string, op: OpEnvelope['op']) =>
      byUser.set(userId, [...(byUser.get(userId) ?? []), { id: randomUUID(), at: Date.now(), op }])
    const due = new Map<string, Set<string>>()
    for (const t of snoozed) due.set(t.user_id, (due.get(t.user_id) ?? new Set()).add(t.id))
    for (const r of reminders) {
      if (r.fire) due.set(r.user_id, (due.get(r.user_id) ?? new Set()).add(r.thread_id))
    }
    for (const [userId, ids] of due) add(userId, { kind: 'unsnooze', threadIds: [...ids] })
    for (const r of reminders) {
      if (!r.fire) add(r.user_id, { kind: 'unremind', threadIds: [r.thread_id] })
    }

    const results: WakeResult[] = []
    for (const [userId, ops] of byUser)
      results.push({ userId, ...(await acceptOpsIn(tx, userId, ops)) })
    return results
  })
}

/**
 * Links compose reminders to the thread of their sent copy once it has synced. A newer
 * reminder replaces one the thread already had. Returns the threads that changed.
 */
export async function attachSentReminders(
  tx: Queryable,
  accountId: string,
  messageIds: string[],
): Promise<string[]> {
  if (!messageIds.length) return []
  const hits = await tx.query<{ id: string; thread_id: string }>(
    `SELECT DISTINCT ON (m.thread_id) r.id, m.thread_id FROM reminders r
     JOIN messages m ON m.account_id = r.account_id AND m.rfc822_message_id = r.sent_message_id
     WHERE r.account_id = $1 AND r.thread_id IS NULL AND m.id = ANY($2::uuid[])
     ORDER BY m.thread_id, r.created_at DESC`,
    [accountId, messageIds],
  )
  if (!hits.length) return []
  await tx.query(`DELETE FROM reminders WHERE thread_id = ANY($1::uuid[])`, [
    hits.map((h) => h.thread_id),
  ])
  await tx.query(
    `UPDATE reminders r SET thread_id = x.thread_id
     FROM unnest($1::uuid[], $2::uuid[]) AS x(id, thread_id) WHERE r.id = x.id`,
    [hits.map((h) => h.id), hits.map((h) => h.thread_id)],
  )
  return hits.map((h) => h.thread_id)
}

/**
 * Ends the snooze of threads that just got a reply from someone else, so the reply shows in
 * the inbox now instead of at the snooze time. Returns the threads that changed.
 */
export async function unsnoozeOnReply(tx: Queryable, messageIds: string[]): Promise<string[]> {
  if (!messageIds.length) return []
  const rows = await tx.query<{ id: string }>(
    `UPDATE threads t SET snoozed_until = NULL, updated_at = now()
     FROM messages m JOIN accounts a ON a.id = m.account_id
     WHERE m.id = ANY($1::uuid[]) AND t.id = m.thread_id AND t.snoozed_until IS NOT NULL
       AND m.date > t.last_message_at AND ${FROM_SOMEONE_ELSE}
     RETURNING t.id`,
    [messageIds],
  )
  return [...new Set(rows.map((r) => r.id))]
}
