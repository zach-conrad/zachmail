import type { MessageRow, SearchContext, SearchPlan, ThreadRow } from '@zachhub/core'
import { toTsQuery } from '@zachhub/core'
import type { Queryable } from './sql'
import { SELECT_MESSAGE, SELECT_THREAD } from './sync'

/** Accounts and folders, to resolve `account:`, `label:`, `in:` and `me` in a query. */
export async function loadSearchContext(db: Queryable, userId: string): Promise<SearchContext> {
  const [accounts, folders] = await Promise.all([
    db.query<SearchContext['accounts'][number]>(
      `SELECT id, email, short_name AS "shortName", display_name AS "displayName"
       FROM accounts WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    ),
    db.query<SearchContext['folders'][number]>(
      `SELECT id, account_id AS "accountId", name, kind FROM folders WHERE user_id = $1`,
      [userId],
    ),
  ])
  return { accounts, folders }
}

export interface MirrorSearchOptions {
  limit: number
  /** Keyset cursor: continue after this thread (its lastMessageAt and id). */
  after?: { at: number; id: string } | null
  /** Only threads whose last message is older than this (epoch ms): what a replica lacks. */
  olderThan?: number | null
}

/**
 * Threads of the mirror matching a plan, newest first. A thread matches when one of its
 * messages satisfies every message-level condition (full text, flags, dates) and the thread
 * satisfies the folder and account conditions.
 */
export async function searchMirror(
  db: Queryable,
  userId: string,
  plan: SearchPlan,
  opts: MirrorSearchOptions,
): Promise<ThreadRow[]> {
  const params: unknown[] = [userId]
  const p = (v: unknown) => `$${params.push(v)}`
  const where = ['t.user_id = $1']
  const msg: string[] = []

  if (plan.accountIds) where.push(`t.account_id = ANY(${p(plan.accountIds)}::uuid[])`)
  for (const f of plan.folders)
    where.push(
      `${f.negated ? 'NOT ' : ''}EXISTS (SELECT 1 FROM thread_folders tf
         WHERE tf.thread_id = t.id AND tf.folder_id = ANY(${p(f.ids)}::uuid[]))`,
    )
  if (opts.olderThan != null)
    where.push(`t.last_message_at < to_timestamp(${p(opts.olderThan / 1000)})`)
  if (opts.after)
    where.push(
      `(t.last_message_at, t.id) < (to_timestamp(${p(opts.after.at / 1000)}), ${p(opts.after.id)}::uuid)`,
    )

  const ts = toTsQuery(plan.match)
  if (ts) msg.push(`m.search @@ to_tsquery('simple', ${p(ts)})`)
  if (plan.unread !== undefined) msg.push(`m.unread = ${p(plan.unread)}`)
  if (plan.starred !== undefined) msg.push(`m.starred = ${p(plan.starred)}`)
  if (plan.attachment !== undefined) msg.push(`m.has_attachments = ${p(plan.attachment)}`)
  if (plan.after !== undefined) msg.push(`m.date >= to_timestamp(${p(plan.after / 1000)})`)
  if (plan.before !== undefined) msg.push(`m.date < to_timestamp(${p(plan.before / 1000)})`)
  if (msg.length)
    where.push(
      `t.id IN (SELECT m.thread_id FROM messages m WHERE m.user_id = $1 AND ${msg.join(' AND ')})`,
    )

  return db.query<ThreadRow>(
    `${SELECT_THREAD} WHERE ${where.join(' AND ')}
     ORDER BY t.last_message_at DESC, t.id DESC LIMIT ${p(opts.limit)}`,
    params,
  )
}

/** Thread rows by id (in the given order) and all their messages. */
export async function readThreads(
  db: Queryable,
  userId: string,
  ids: string[],
): Promise<{ threads: ThreadRow[]; messages: MessageRow[] }> {
  if (!ids.length) return { threads: [], messages: [] }
  const [threads, messages] = await Promise.all([
    db.query<ThreadRow>(`${SELECT_THREAD} WHERE t.user_id = $1 AND t.id = ANY($2::uuid[])`, [
      userId,
      ids,
    ]),
    readMessages(db, userId, ids),
  ])
  const order = new Map(ids.map((id, i) => [id, i]))
  threads.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  return { threads, messages }
}

export async function readMessages(db: Queryable, userId: string, threadIds: string[]) {
  if (!threadIds.length) return []
  return db.query<MessageRow>(
    `${SELECT_MESSAGE} WHERE m.user_id = $1 AND m.thread_id = ANY($2::uuid[]) ORDER BY m.date, m.id`,
    [userId, threadIds],
  )
}

/** Thread ids of the mirror for provider thread ids of one account. */
export async function mirroredThreadIds(
  db: Queryable,
  accountId: string,
  providerThreadIds: string[],
): Promise<Map<string, string>> {
  if (!providerThreadIds.length) return new Map()
  const rows = await db.query<{ id: string; provider_thread_id: string }>(
    `SELECT id, provider_thread_id FROM threads WHERE account_id = $1 AND provider_thread_id = ANY($2::text[])`,
    [accountId, providerThreadIds],
  )
  return new Map(rows.map((r) => [r.provider_thread_id, r.id]))
}

/** Per account, the oldest thread activity the mirror holds (epoch ms); absent when empty. */
export async function mirrorHorizons(db: Queryable, userId: string): Promise<Map<string, number>> {
  const rows = await db.query<{ account_id: string; at: number }>(
    `SELECT account_id, (extract(epoch FROM min(last_message_at)) * 1000)::float8 AS at
     FROM threads WHERE user_id = $1 GROUP BY account_id`,
    [userId],
  )
  return new Map(rows.map((r) => [r.account_id, r.at]))
}
