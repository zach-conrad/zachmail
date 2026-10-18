import type { Deletes, EntityRow, OpStatusRow, Rows, SyncDelta } from '@zachhub/core'
import { emptyDeletes, emptyRows } from '@zachhub/core'
import type { SyncBatch } from '@zachhub/providers'
import { attachSentReminders, unsnoozeOnReply } from './snooze'
import { SELECT_SPLIT_RULE, recomputeSplits } from './splits'
import { SELECT_NUDGE_DISMISSAL, SELECT_SNIPPET } from './composer'
import { loadEntities, readEntityDeltas, type EntityRegistry } from './entities'
import type { Db, Queryable } from './sql'

type Entity = keyof Deletes

export async function recordChanges(
  tx: Queryable,
  userId: string,
  /** A mail entity, 'op', or a namespaced first-party kind ('tasks.task'). */
  entity: Entity | 'op' | (string & {}),
  ids: string[],
  op: 'upsert' | 'delete',
) {
  if (ids.length === 0) return
  await tx.query(
    `INSERT INTO changes (user_id, entity, entity_id, op) SELECT $1, $2, unnest($3::text[]), $4`,
    [userId, entity, ids, op],
  )
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

/**
 * Writes one provider batch into the mirror and the change log in a single transaction:
 * folders, threads, messages, attachments, then recomputed thread aggregates and folder
 * membership. Unchanged rows produce no change entries, so re-syncing is cheap and quiet.
 * `inserted` lists messages new to the mirror (what notifications look at).
 */
export async function applySyncBatch(
  db: Db,
  args: { userId: string; accountId: string; batch: SyncBatch },
): Promise<{ changed: number; inserted: string[] }> {
  const { userId, accountId, batch } = args
  return db.transaction(async (tx) => {
    let changed = 0
    let inserted: string[] = []
    const affectedThreads = new Set<string>()

    if (batch.folders) {
      const input = batch.folders.map((f) => ({
        provider_id: f.providerId,
        name: f.name,
        kind: f.kind,
        unread_count: f.unreadCount,
        total_count: f.totalCount,
      }))
      const up = await tx.query<{ id: string }>(
        `INSERT INTO folders (user_id, account_id, provider_id, name, kind, unread_count, total_count)
         SELECT $1, $2, x.provider_id, x.name, x.kind::folder_kind, x.unread_count, x.total_count
         FROM jsonb_to_recordset($3::jsonb) AS x(provider_id text, name text, kind text, unread_count int, total_count int)
         ON CONFLICT (account_id, provider_id) DO UPDATE SET
           name = excluded.name, kind = excluded.kind,
           unread_count = excluded.unread_count, total_count = excluded.total_count, updated_at = now()
         WHERE (folders.name, folders.kind, folders.unread_count, folders.total_count)
           IS DISTINCT FROM (excluded.name, excluded.kind, excluded.unread_count, excluded.total_count)
         RETURNING id`,
        [userId, accountId, input],
      )
      await recordChanges(tx, userId, 'folder', ids(up), 'upsert')

      // Find threads labelled with a vanished folder before the cascade removes the evidence.
      const touched = await tx.query<{ thread_id: string }>(
        `SELECT DISTINCT m.thread_id FROM messages m
         JOIN folders f ON f.account_id = m.account_id AND f.provider_id = ANY(m.provider_labels)
         WHERE f.account_id = $1 AND NOT (f.provider_id = ANY($2::text[]))`,
        [accountId, input.map((f) => f.provider_id)],
      )
      touched.forEach((r) => affectedThreads.add(r.thread_id))
      const gone = await tx.query<{ id: string }>(
        `DELETE FROM folders WHERE account_id = $1 AND NOT (provider_id = ANY($2::text[])) RETURNING id`,
        [accountId, input.map((f) => f.provider_id)],
      )
      await recordChanges(tx, userId, 'folder', ids(gone), 'delete')
      changed += up.length + gone.length
    }

    if (batch.messages.length) {
      const threadIds = [...new Set(batch.messages.map((m) => m.providerThreadId))]
      await tx.query(
        `INSERT INTO threads (user_id, account_id, provider_thread_id, last_message_at)
         SELECT $1, $2, t, to_timestamp(0) FROM unnest($3::text[]) AS t
         ON CONFLICT (account_id, provider_thread_id) DO NOTHING`,
        [userId, accountId, threadIds],
      )

      const input = batch.messages.map((m) => ({
        provider_message_id: m.providerMessageId,
        provider_thread_id: m.providerThreadId,
        rfc822_message_id: m.rfc822MessageId,
        in_reply_to: m.inReplyTo,
        refs: m.references,
        from_addr: m.from,
        to_addr: m.to,
        cc: m.cc,
        bcc: m.bcc,
        reply_to: m.replyTo,
        subject: m.subject,
        snippet: m.snippet,
        date: m.date.toISOString(),
        labels: m.folderIds,
        unread: m.unread,
        starred: m.starred,
        has_attachments: m.hasAttachments,
        list_unsubscribe: m.listUnsubscribe,
        size: m.size,
      }))
      const up = await tx.query<{ id: string; thread_id: string; inserted: boolean }>(
        `INSERT INTO messages (user_id, account_id, thread_id, provider_message_id, rfc822_message_id, in_reply_to,
           "references", "from", "to", cc, bcc, reply_to, subject, snippet, date, provider_labels,
           unread, starred, has_attachments, list_unsubscribe, size)
         SELECT $1, $2, t.id, x.provider_message_id, x.rfc822_message_id, x.in_reply_to,
           ARRAY(SELECT jsonb_array_elements_text(x.refs)), x.from_addr, x.to_addr, x.cc, x.bcc, x.reply_to,
           x.subject, x.snippet, x.date, ARRAY(SELECT jsonb_array_elements_text(x.labels)),
           x.unread, x.starred, x.has_attachments, x.list_unsubscribe, x.size
         FROM jsonb_to_recordset($3::jsonb) AS x(
           provider_message_id text, provider_thread_id text, rfc822_message_id text, in_reply_to text,
           refs jsonb, from_addr jsonb, to_addr jsonb, cc jsonb, bcc jsonb, reply_to jsonb,
           subject text, snippet text, date timestamptz, labels jsonb,
           unread boolean, starred boolean, has_attachments boolean, list_unsubscribe text, size int)
         JOIN threads t ON t.account_id = $2 AND t.provider_thread_id = x.provider_thread_id
         ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
           provider_labels = excluded.provider_labels, unread = excluded.unread, starred = excluded.starred,
           snippet = excluded.snippet, updated_at = now()
         WHERE (messages.provider_labels, messages.unread, messages.starred, messages.snippet)
           IS DISTINCT FROM (excluded.provider_labels, excluded.unread, excluded.starred, excluded.snippet)
         RETURNING id, thread_id, (xmax = 0) AS inserted`,
        [userId, accountId, input],
      )
      up.forEach((r) => affectedThreads.add(r.thread_id))
      await recordChanges(tx, userId, 'message', ids(up), 'upsert')
      changed += up.length

      const insertedIds = up.filter((r) => r.inserted).map((r) => r.id)
      // Their threads are already in affectedThreads, so the changes get logged below.
      await unsnoozeOnReply(tx, insertedIds)
      await attachSentReminders(tx, accountId, insertedIds)
      inserted = insertedIds
      const atts = batch.messages.flatMap((m) =>
        m.attachments.map((a) => ({
          provider_message_id: m.providerMessageId,
          filename: a.filename,
          mime: a.mime,
          size: a.size,
          provider_attachment_id: a.providerAttachmentId,
          content_id: a.contentId,
          inline: a.inline,
        })),
      )
      if (insertedIds.length && atts.length) {
        await tx.query(
          `INSERT INTO attachments (user_id, message_id, filename, mime, size, provider_attachment_id, content_id, inline)
           SELECT $1, m.id, x.filename, x.mime, x.size, x.provider_attachment_id, x.content_id, x.inline
           FROM jsonb_to_recordset($3::jsonb) AS x(provider_message_id text, filename text, mime text, size int,
             provider_attachment_id text, content_id text, inline boolean)
           JOIN messages m ON m.account_id = $2 AND m.provider_message_id = x.provider_message_id
           WHERE m.id = ANY($4::uuid[])`,
          [userId, accountId, atts, insertedIds],
        )
      }
    }

    if (batch.deletedMessageIds.length) {
      const gone = await tx.query<{ id: string; thread_id: string }>(
        `DELETE FROM messages WHERE account_id = $1 AND provider_message_id = ANY($2::text[]) RETURNING id, thread_id`,
        [accountId, batch.deletedMessageIds],
      )
      gone.forEach((r) => affectedThreads.add(r.thread_id))
      await recordChanges(tx, userId, 'message', ids(gone), 'delete')
      changed += gone.length
    }

    if (affectedThreads.size) {
      const threadIds = [...affectedThreads]
      const emptied = await tx.query<{ id: string }>(
        `DELETE FROM threads t WHERE t.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id) RETURNING id`,
        [threadIds],
      )
      await recordChanges(tx, userId, 'thread', ids(emptied), 'delete')
      const live = threadIds.filter((id) => !emptied.some((e) => e.id === id))
      if (live.length) {
        await recomputeThreads(tx, userId, live)
        await recordChanges(tx, userId, 'thread', live, 'upsert')
      }
      changed += threadIds.length
    }

    return { changed, inserted }
  })
}

export async function recomputeThreads(tx: Queryable, userId: string, threadIds: string[]) {
  await tx.query(
    `WITH agg AS (
       SELECT m.thread_id,
         count(*)::int AS message_count,
         max(m.date) AS last_message_at,
         bool_or(m.unread) AS unread,
         bool_or(m.starred) AS starred,
         bool_or(m.has_attachments) AS has_attachments,
         (array_agg(m.subject ORDER BY m.date ASC))[1] AS subject,
         (array_agg(m.snippet ORDER BY m.date DESC))[1] AS snippet
       FROM messages m WHERE m.thread_id = ANY($1::uuid[]) GROUP BY m.thread_id
     ), senders AS (
       SELECT thread_id, (array_agg("from" ORDER BY last_seen DESC))[1:5] AS list FROM (
         SELECT m.thread_id, (array_agg(m."from" ORDER BY m.date DESC))[1] AS "from", max(m.date) AS last_seen
         FROM messages m WHERE m.thread_id = ANY($1::uuid[]) AND m."from" IS NOT NULL
         GROUP BY m.thread_id, m."from"->>'email'
       ) s GROUP BY thread_id
     )
     UPDATE threads t SET
       message_count = agg.message_count, last_message_at = agg.last_message_at, unread = agg.unread,
       starred = agg.starred, has_attachments = agg.has_attachments, subject = agg.subject,
       snippet = agg.snippet, participants = COALESCE(to_jsonb(senders.list), '[]'::jsonb), updated_at = now()
     FROM agg LEFT JOIN senders USING (thread_id)
     WHERE t.id = agg.thread_id`,
    [threadIds],
  )
  await tx.query(`DELETE FROM thread_folders WHERE thread_id = ANY($1::uuid[])`, [threadIds])
  await tx.query(
    `INSERT INTO thread_folders (thread_id, folder_id, user_id)
     SELECT DISTINCT m.thread_id, f.id, $2::uuid FROM messages m
     JOIN folders f ON f.account_id = m.account_id AND f.provider_id = ANY(m.provider_labels)
     WHERE m.thread_id = ANY($1::uuid[])
     ON CONFLICT DO NOTHING`,
    [threadIds, userId],
  )
  await recomputeSplits(tx, userId, threadIds)
}

/** Records that the backfill has mirrored an account's whole history (search stops asking it). */
export async function markMirrorComplete(db: Queryable, accountId: string) {
  await db.query(
    `UPDATE accounts SET sync_state = sync_state || '{"mirrorComplete": true}' WHERE id = $1`,
    [accountId],
  )
}

export async function updateAccount(
  db: Queryable,
  accountId: string,
  patch: {
    syncState?: Record<string, unknown>
    status?: string
    lastSyncedAt?: Date
    lastError?: string | null
  },
) {
  const rows = await db.query<{ user_id: string }>(
    // mirrorComplete is engine bookkeeping, not a provider cursor: keep it across cursor writes.
    `UPDATE accounts SET
       sync_state = COALESCE($2::jsonb || jsonb_strip_nulls(
         jsonb_build_object('mirrorComplete', sync_state -> 'mirrorComplete')), sync_state),
       status = COALESCE($3::account_status, status),
       last_synced_at = COALESCE($4::timestamptz, last_synced_at),
       last_error = CASE WHEN $5::boolean THEN $6 ELSE last_error END
     WHERE id = $1 RETURNING user_id`,
    [
      accountId,
      patch.syncState ?? null,
      patch.status ?? null,
      patch.lastSyncedAt?.toISOString() ?? null,
      patch.lastError !== undefined,
      patch.lastError ?? null,
    ],
  )
  const userId = rows[0]?.user_id
  if (userId) await recordChanges(db, userId, 'account', [accountId], 'upsert')
}

/** Tells the user's clients to pull (Supabase Realtime broadcast). */
export async function nudge(db: Queryable, userId: string) {
  await db.query(`SELECT public.nudge_user($1)`, [userId])
}

// ---- Reads (API) ----

const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::float8`

const SELECT_ACCOUNT = `SELECT a.id, a.provider, a.email, a.display_name AS "displayName", a.short_name AS "shortName",
  a.color, a.status, ${ms('a.last_synced_at')} AS "lastSyncedAt", a.last_error AS "lastError" FROM accounts a`

const SELECT_FOLDER = `SELECT f.id, f.account_id AS "accountId", f.provider_id AS "providerId", f.name, f.kind,
  f.unread_count AS "unreadCount", f.total_count AS "totalCount" FROM folders f`

export const SELECT_THREAD = `SELECT t.id, t.account_id AS "accountId", t.subject, t.snippet, t.participants,
  ${ms('t.last_message_at')} AS "lastMessageAt", t.message_count AS "messageCount", t.unread, t.starred,
  t.has_attachments AS "hasAttachments", t.muted, ${ms('t.snoozed_until')} AS "snoozedUntil",
  (SELECT jsonb_build_object('at', ${ms('r.remind_at')}, 'condition', r.condition)
   FROM reminders r WHERE r.thread_id = t.id) AS reminder,
  CASE WHEN t.ai_category IS NULL THEN NULL ELSE jsonb_build_object('category', t.ai_category,
    'summary', t.ai_summary, 'needsReply', t.ai_needs_reply) END AS ai,
  COALESCE((SELECT array_agg(tf.folder_id::text) FROM thread_folders tf WHERE tf.thread_id = t.id), '{}') AS "folderIds"
  FROM threads t`

export const SELECT_MESSAGE = `SELECT m.id, m.thread_id AS "threadId", m.account_id AS "accountId", m."from", m."to", m.cc,
  m.reply_to AS "replyTo", m.subject, m.snippet, ${ms('m.date')} AS date, m.unread, m.starred,
  m.has_attachments AS "hasAttachments", m.list_unsubscribe AS "listUnsubscribe",
  m.rfc822_message_id AS "rfc822MessageId", m.body_status AS "bodyStatus" FROM messages m`

/** Compacted delta after `since`: latest op per entity, current rows for upserts. */
export async function readDelta(
  db: Db,
  userId: string,
  since: number,
  limit = 5000,
  entities?: EntityRegistry,
): Promise<SyncDelta> {
  return db.transaction(async (tx) => {
    const window = await tx.query<{ seq: number }>(
      `SELECT seq::float8 AS seq FROM changes WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [userId, since, limit + 1],
    )
    const more = window.length > limit
    const upTo = more ? window[limit - 1]!.seq : (window.at(-1)?.seq ?? since)
    const latest = await tx.query<{
      entity: Entity | 'op' | (string & {})
      entity_id: string
      op: 'upsert' | 'delete'
    }>(
      `SELECT DISTINCT ON (entity, entity_id) entity, entity_id, op FROM changes
       WHERE user_id = $1 AND seq > $2 AND seq <= $3 ORDER BY entity, entity_id, seq DESC`,
      [userId, since, upTo],
    )

    const want: Record<Entity, string[]> = {
      account: [],
      folder: [],
      thread: [],
      message: [],
      splitRule: [],
      snippet: [],
      nudgeDismissal: [],
    }
    const deletes = emptyDeletes()
    const opIds: string[] = []
    const firstParty: typeof latest = []
    for (const c of latest) {
      if (c.entity === 'op') opIds.push(c.entity_id)
      else if (c.entity.includes('.')) firstParty.push(c)
      else {
        const e = c.entity as Entity
        ;(c.op === 'delete' ? deletes[e] : want[e]).push(c.entity_id)
      }
    }

    const upserts = emptyRows()
    const load = async <K extends keyof Rows>(
      key: K,
      select: string,
      alias: string,
      list: string[],
    ) => {
      if (!list.length) return
      const rows = await tx.query<Rows[K][number]>(
        `${select} WHERE ${alias}.id = ANY($1::uuid[])`,
        [list],
      )
      upserts[key] = rows as Rows[K]
      // An upsert whose row is gone by now (deleted later in a not-yet-read window) is a delete.
      const found = new Set(rows.map((r) => r.id))
      list.filter((id) => !found.has(id)).forEach((id) => deletes[entityOf(key)].push(id))
    }
    await load('accounts', SELECT_ACCOUNT, 'a', want.account)
    await load('folders', SELECT_FOLDER, 'f', want.folder)
    await load('threads', SELECT_THREAD, 't', want.thread)
    await load('messages', SELECT_MESSAGE, 'm', want.message)
    await load('splitRules', SELECT_SPLIT_RULE, 'r', want.splitRule)
    await load('snippets', SELECT_SNIPPET, 's', want.snippet)
    await load('nudgeDismissals', SELECT_NUDGE_DISMISSAL, 'n', want.nudgeDismissal)

    const ops = opIds.length ? await readOpStatuses(tx, userId, opIds) : []
    const delta: SyncDelta = { seq: upTo, more, upserts, deletes, ops }
    if (entities) delta.entities = await readEntityDeltas(tx, userId, entities, firstParty)
    return delta
  })
}

/** One status per op, folded over its per-account outbox rows. */
export async function readOpStatuses(
  db: Queryable,
  userId: string,
  opIds: string[],
): Promise<OpStatusRow[]> {
  return db.query<OpStatusRow>(
    `SELECT op_id::text AS id,
       CASE WHEN bool_or(state = 'failed') THEN 'failed'
            WHEN bool_and(state = 'done') THEN 'done' ELSE 'pending' END AS state,
       max(last_error) FILTER (WHERE state = 'failed') AS error
     FROM outbox WHERE user_id = $1 AND op_id = ANY($2::uuid[]) GROUP BY op_id`,
    [userId, opIds],
  )
}

const entityOf = (k: keyof Rows): Entity =>
  (
    ({
      accounts: 'account',
      folders: 'folder',
      threads: 'thread',
      messages: 'message',
      splitRules: 'splitRule',
      snippets: 'snippet',
      nudgeDismissals: 'nudgeDismissal',
    }) as const
  )[k]

/**
 * Initial replica: everything for threads active in the last `days`, in chunks the API
 * streams as NDJSON. Runs in one REPEATABLE READ snapshot so `seq` matches the rows exactly.
 */
export async function readBootstrap(
  db: Db,
  userId: string,
  days: number,
  onRows: (rows: Partial<Rows>) => void,
  chunk = 1000,
  entities?: { registry: EntityRegistry; onRows: (kind: string, rows: EntityRow[]) => void },
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`)
    const [{ seq } = { seq: 0 }] = await tx.query<{ seq: number }>(
      `SELECT COALESCE(max(seq), 0)::float8 AS seq FROM changes WHERE user_id = $1`,
      [userId],
    )
    onRows({
      accounts: await tx.query(`${SELECT_ACCOUNT} WHERE a.user_id = $1`, [userId]),
      folders: await tx.query(`${SELECT_FOLDER} WHERE f.user_id = $1`, [userId]),
      splitRules: await tx.query(`${SELECT_SPLIT_RULE} WHERE r.user_id = $1`, [userId]),
      snippets: await tx.query(`${SELECT_SNIPPET} WHERE s.user_id = $1`, [userId]),
      nudgeDismissals: await tx.query(`${SELECT_NUDGE_DISMISSAL} WHERE n.user_id = $1`, [userId]),
    })
    const cutoff = `now() - make_interval(days => $2)`
    let cursor: { at: number; id: string } | null = null
    for (;;) {
      const threads: Rows['threads'] = await tx.query(
        `${SELECT_THREAD} WHERE t.user_id = $1 AND t.last_message_at > ${cutoff}
           AND ($3::float8 IS NULL OR (${ms('t.last_message_at')}, t.id) < ($3::float8, $5::uuid))
         ORDER BY t.last_message_at DESC, t.id DESC LIMIT $4`,
        [userId, days, cursor?.at ?? null, chunk, cursor?.id ?? null],
      )
      if (!threads.length) break
      const messages: Rows['messages'] = await tx.query(
        `${SELECT_MESSAGE} WHERE m.thread_id = ANY($1::uuid[]) ORDER BY m.date`,
        [threads.map((t) => t.id)],
      )
      onRows({ threads, messages })
      if (threads.length < chunk) break
      const last = threads.at(-1)!
      cursor = { at: last.lastMessageAt, id: last.id }
    }
    // First-party data is small and all of it is wanted offline: no window.
    for (const t of entities?.registry.tables ?? []) {
      const rows = await loadEntities(tx, userId, t, null)
      for (let i = 0; i < rows.length; i += chunk)
        entities!.onRows(t.kind, rows.slice(i, i + chunk))
    }
    return seq
  })
}

/** Accounts that should be syncing but haven't finished a sync in `olderThanMinutes`. */
export async function staleSyncAccounts(db: Queryable, olderThanMinutes: number) {
  return db.query<{
    id: string
    userId: string
    email: string
    status: string
    lastSyncedAt: Date | null
  }>(
    `SELECT id, user_id AS "userId", email, status, last_synced_at AS "lastSyncedAt" FROM accounts
     WHERE status IN ('active', 'backfilling', 'error')
       AND coalesce(last_synced_at, created_at) < now() - make_interval(mins => $1)
     ORDER BY last_synced_at NULLS FIRST`,
    [olderThanMinutes],
  )
}
