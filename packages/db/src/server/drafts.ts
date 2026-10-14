import type { DraftRequest } from '@zachmail/core'
import type { SendPayload } from './outbox'
import type { Queryable } from './sql'

export interface DraftRecord {
  id: string
  userId: string
  accountId: string
  payload: SendPayload
  version: number
  syncedVersion: number
  providerDraftId: string | null
  deleted: boolean
}

/** Upserts a draft and bumps its version. Returns null when the id belongs to someone else. */
export async function saveDraft(
  db: Queryable,
  userId: string,
  id: string,
  req: DraftRequest,
): Promise<number | null> {
  const payload: SendPayload = {
    to: req.to,
    cc: req.cc ?? [],
    bcc: req.bcc ?? [],
    subject: req.subject,
    html: req.html,
    replyToMessageId: req.replyToMessageId ?? null,
  }
  const [row] = await db.query<{ version: number }>(
    `INSERT INTO drafts (id, user_id, account_id, payload)
     SELECT $1, $2, a.id, $4::jsonb FROM accounts a WHERE a.id = $3 AND a.user_id = $2
     ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, payload = excluded.payload,
       version = drafts.version + 1, deleted = false, updated_at = now()
     WHERE drafts.user_id = $2
     RETURNING version`,
    [id, userId, req.accountId, payload],
  )
  return row?.version ?? null
}

/** Marks a draft deleted (the worker removes the provider copy, then the row). */
export async function deleteDraft(db: Queryable, userId: string, id: string) {
  const rows = await db.query<{ account_id: string }>(
    `UPDATE drafts SET deleted = true, version = version + 1, updated_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING account_id`,
    [id, userId],
  )
  return rows[0]?.account_id ?? null
}

export async function loadDraft(db: Queryable, id: string): Promise<DraftRecord | null> {
  const [row] = await db.query<DraftRecord>(
    `SELECT id, user_id AS "userId", account_id AS "accountId", payload, version,
       synced_version AS "syncedVersion", provider_draft_id AS "providerDraftId", deleted
     FROM drafts WHERE id = $1`,
    [id],
  )
  return row ?? null
}

/** Records that `version` reached the provider, unless a newer save already did. */
export async function markDraftSynced(
  db: Queryable,
  id: string,
  version: number,
  providerDraftId: string,
) {
  await db.query(
    `UPDATE drafts SET synced_version = GREATEST(synced_version, $2), provider_draft_id = $3
     WHERE id = $1`,
    [id, version, providerDraftId],
  )
}

/** Drops a deleted draft once its provider copy is gone, unless it was saved again since. */
export async function purgeDraft(db: Queryable, id: string, version: number) {
  await db.query(`DELETE FROM drafts WHERE id = $1 AND deleted AND version = $2`, [id, version])
}
