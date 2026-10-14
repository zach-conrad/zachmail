import {
  compileSplitRules,
  inboundSender,
  type FolderKind,
  type SplitRuleRow,
  type CompiledSplitRules,
} from '@zachmail/core'
import type { Db, Queryable } from './sql'
import { recordChanges } from './sync'

export const SELECT_SPLIT_RULE = `SELECT r.id::text AS id, r.name, r.target, r.match, r.conditions,
  r.position FROM split_rules r`

export async function readSplitRules(db: Queryable, userId: string): Promise<SplitRuleRow[]> {
  return db.query<SplitRuleRow>(`${SELECT_SPLIT_RULE} WHERE r.user_id = $1 ORDER BY r.position`, [
    userId,
  ])
}

/** Inserts or replaces a rule; false when the id belongs to another user. */
export async function upsertSplitRule(
  db: Db,
  userId: string,
  rule: SplitRuleRow,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO split_rules (id, user_id, name, target, match, conditions, position)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, target = excluded.target,
         match = excluded.match, conditions = excluded.conditions, position = excluded.position,
         updated_at = now()
       WHERE split_rules.user_id = excluded.user_id
       RETURNING id`,
      [rule.id, userId, rule.name, rule.target, rule.match, rule.conditions, rule.position],
    )
    if (!rows.length) return false
    await recordChanges(tx, userId, 'splitRule', [rule.id], 'upsert')
    return true
  })
}

/** Deletes a rule; idempotent. */
export async function deleteSplitRule(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const gone = await tx.query<{ id: string }>(
      `DELETE FROM split_rules WHERE id = $1 AND user_id = $2 RETURNING id::text AS id`,
      [id, userId],
    )
    await recordChanges(tx, userId, 'splitRule', gone.length ? [id] : [], 'delete')
  })
}

const CHUNK = 1000

interface SplitSqlRow {
  id: string
  account_id: string
  subject: string
  split: string | null
  folder_ids: string[]
  kinds: FolderKind[]
  has_important: boolean
  list_unsub: boolean
  senders: (string | null)[]
  first: string | null
  recipients: string[] | null
}

/**
 * Recomputes `threads.split` with the same core evaluation the clients run: for the given
 * threads (after ingest or a triage op), or for every inbox thread of the user when null
 * (after a rule change). Returns how many threads changed split.
 */
export async function recomputeSplits(
  tx: Queryable,
  userId: string,
  threadIds: string[] | null,
  rules?: CompiledSplitRules,
): Promise<number> {
  const compiled = rules ?? compileSplitRules(await readSplitRules(tx, userId))
  const own = new Set(
    (
      await tx.query<{ email: string }>(
        `SELECT lower(email) AS email FROM accounts WHERE user_id = $1`,
        [userId],
      )
    ).map((r) => r.email),
  )
  const recipients = compiled.needsRecipients
    ? `ARRAY(SELECT DISTINCT lower(r->>'email') FROM messages m,
         jsonb_array_elements(m."to" || m.cc) r WHERE m.thread_id = t.id)`
    : 'NULL::text[]'
  const select = (where: string) =>
    `SELECT t.id::text AS id, t.account_id::text AS account_id, t.subject, t.split,
       COALESCE(ARRAY(SELECT tf.folder_id::text FROM thread_folders tf WHERE tf.thread_id = t.id), '{}') AS folder_ids,
       COALESCE(ARRAY(SELECT f.kind::text FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
         WHERE tf.thread_id = t.id), '{}') AS kinds,
       EXISTS (SELECT 1 FROM folders f WHERE f.account_id = t.account_id AND f.kind = 'important') AS has_important,
       EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.list_unsubscribe IS NOT NULL) AS list_unsub,
       ARRAY(SELECT lower(m."from"->>'email') FROM messages m WHERE m.thread_id = t.id
         ORDER BY m.date DESC LIMIT 5) AS senders,
       lower(t.participants->0->>'email') AS first,
       ${recipients} AS recipients
     FROM threads t WHERE t.user_id = $1 AND ${where}`

  let changed = 0
  const run = async (rows: SplitSqlRow[]) => {
    const updates: { id: string; split: string | null }[] = []
    for (const r of rows) {
      const split = compiled.test({
        accountId: r.account_id,
        subject: r.subject,
        folderIds: r.folder_ids,
        folderKinds: r.kinds,
        accountHasImportant: r.has_important,
        hasListUnsubscribe: r.list_unsub,
        fromEmail: inboundSender(r.senders, own, r.first),
        recipients: r.recipients ?? undefined,
      })
      if (split !== r.split) updates.push({ id: r.id, split })
    }
    if (updates.length)
      await tx.query(
        `UPDATE threads t SET split = x.split FROM jsonb_to_recordset($1::jsonb) AS x(id uuid, split text)
         WHERE t.id = x.id`,
        [updates],
      )
    changed += updates.length
  }

  if (threadIds) {
    for (let i = 0; i < threadIds.length; i += CHUNK)
      await run(
        await tx.query<SplitSqlRow>(select(`t.id = ANY($2::uuid[])`), [
          userId,
          threadIds.slice(i, i + CHUNK),
        ]),
      )
    return changed
  }
  // Every thread that is in an inbox now or had a split before (it may have to lose it).
  let after = '00000000-0000-0000-0000-000000000000'
  for (;;) {
    const rows = await tx.query<SplitSqlRow>(
      `${select(`t.id > $2::uuid AND (t.split IS NOT NULL OR EXISTS (
         SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
         WHERE tf.thread_id = t.id AND f.kind = 'inbox'))`)} ORDER BY t.id LIMIT ${CHUNK}`,
      [userId, after],
    )
    if (!rows.length) break
    await run(rows)
    after = rows.at(-1)!.id
    if (rows.length < CHUNK) break
  }
  return changed
}
