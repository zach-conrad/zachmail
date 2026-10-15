import type { NudgeDismissalRow, SnippetInput, SnippetRow } from '@zachhub/core'
import { MAX_SNIPPETS } from '@zachhub/core'
import type { Db, Queryable } from './sql'
import { recordChanges } from './sync'

const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::float8`

export const SELECT_SNIPPET = `SELECT s.id::text AS id, s.name, s.shortcut, s.subject, s.html, s.cc,
  s.bcc, ${ms('s.updated_at')} AS "updatedAt" FROM snippets s`

// Aliased so readDelta can look rows up by `n.id` like every other entity.
export const SELECT_NUDGE_DISMISSAL = `SELECT n.id::text AS id, n."lastMessageAt" FROM (
  SELECT thread_id AS id, user_id, ${ms('last_message_at')} AS "lastMessageAt"
  FROM nudge_dismissals) n`

export class SnippetConflictError extends Error {
  override name = 'SnippetConflictError'
}

export async function readSnippets(db: Queryable, userId: string): Promise<SnippetRow[]> {
  return db.query<SnippetRow>(`${SELECT_SNIPPET} WHERE s.user_id = $1 ORDER BY s.name`, [userId])
}

/**
 * Inserts or replaces a snippet. Returns false when the id belongs to another user; throws
 * SnippetConflictError when another snippet has the shortcut or the user is at the cap.
 */
export async function upsertSnippet(
  db: Db,
  userId: string,
  id: string,
  s: SnippetInput,
): Promise<boolean> {
  try {
    return await saveSnippet(db, userId, id, s)
  } catch (err) {
    // Two saves racing for one shortcut: the unique index decides.
    if ((err as { code?: string }).code === '23505')
      throw new SnippetConflictError(`;${s.shortcut} is already used`)
    throw err
  }
}

function saveSnippet(db: Db, userId: string, id: string, s: SnippetInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (s.shortcut) {
      const taken = await tx.query<{ name: string }>(
        `SELECT name FROM snippets WHERE user_id = $1 AND shortcut = $2 AND id <> $3`,
        [userId, s.shortcut, id],
      )
      if (taken[0])
        throw new SnippetConflictError(`;${s.shortcut} is already used by "${taken[0].name}"`)
    }
    const [{ n } = { n: 0 }] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM snippets WHERE user_id = $1 AND id <> $2`,
      [userId, id],
    )
    if (n >= MAX_SNIPPETS) throw new SnippetConflictError(`At most ${MAX_SNIPPETS} snippets`)
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO snippets (id, user_id, name, shortcut, subject, html, cc, bcc)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, shortcut = excluded.shortcut,
         subject = excluded.subject, html = excluded.html, cc = excluded.cc, bcc = excluded.bcc,
         updated_at = now()
       WHERE snippets.user_id = excluded.user_id
       RETURNING id`,
      [id, userId, s.name, s.shortcut, s.subject, s.html, s.cc, s.bcc],
    )
    if (!rows.length) return false
    await recordChanges(tx, userId, 'snippet', [id], 'upsert')
    return true
  })
}

/** Deletes a snippet; idempotent. */
export async function deleteSnippet(db: Db, userId: string, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const gone = await tx.query<{ id: string }>(
      `DELETE FROM snippets WHERE id = $1 AND user_id = $2 RETURNING id::text AS id`,
      [id, userId],
    )
    await recordChanges(tx, userId, 'snippet', ids(gone), 'delete')
  })
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

/**
 * Hides the follow-up nudges on these threads until each gets a newer message. Returns the
 * rows written; ids that are not this user's threads are skipped.
 */
export async function dismissNudges(
  db: Db,
  userId: string,
  threadIds: string[],
): Promise<NudgeDismissalRow[]> {
  return db.transaction(async (tx) => {
    const rows = await tx.query<NudgeDismissalRow>(
      `INSERT INTO nudge_dismissals (thread_id, user_id, last_message_at)
       SELECT t.id, t.user_id, t.last_message_at FROM threads t
       WHERE t.id = ANY($1::uuid[]) AND t.user_id = $2
       ON CONFLICT (thread_id) DO UPDATE SET last_message_at = excluded.last_message_at,
         created_at = now()
       RETURNING thread_id::text AS id, ${ms('last_message_at')} AS "lastMessageAt"`,
      [threadIds, userId],
    )
    await recordChanges(tx, userId, 'nudgeDismissal', ids(rows), 'upsert')
    return rows
  })
}

/** Brings dismissed nudges back (undo). */
export async function restoreNudges(db: Db, userId: string, threadIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const gone = await tx.query<{ id: string }>(
      `DELETE FROM nudge_dismissals WHERE thread_id = ANY($1::uuid[]) AND user_id = $2
       RETURNING thread_id::text AS id`,
      [threadIds, userId],
    )
    await recordChanges(tx, userId, 'nudgeDismissal', ids(gone), 'delete')
  })
}
