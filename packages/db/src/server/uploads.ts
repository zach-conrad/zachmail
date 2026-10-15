import type { UploadRequest } from '@zachmail/core'
import type { Queryable } from './sql'

export interface UploadRecord {
  id: string
  storageKey: string
  filename: string
  mime: string
  size: number
}

export async function createUpload(
  db: Queryable,
  userId: string,
  id: string,
  storageKey: string,
  req: UploadRequest,
) {
  await db.query(
    `INSERT INTO uploads (id, user_id, storage_key, filename, mime, size) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, storageKey, req.filename, req.mime, req.size],
  )
}

/** The user's uploads with these ids, in the order asked for. Unknown ids are left out. */
export async function loadUploads(
  db: Queryable,
  userId: string,
  ids: string[],
): Promise<UploadRecord[]> {
  if (!ids.length) return []
  const rows = await db.query<UploadRecord>(
    `SELECT id, storage_key AS "storageKey", filename, mime, size FROM uploads
     WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, ids],
  )
  return ids.flatMap((id) => rows.filter((r) => r.id === id))
}

/**
 * Uploads older than `olderThanHours` that no open send and no live draft points at. Sent mail
 * keeps its copy at the provider, so these are safe to delete from storage.
 */
export async function orphanedUploads(
  db: Queryable,
  olderThanHours: number,
  limit = 100,
): Promise<{ id: string; storageKey: string }[]> {
  return db.query(
    `SELECT u.id, u.storage_key AS "storageKey" FROM uploads u
     WHERE u.created_at < now() - make_interval(hours => $1)
       AND NOT EXISTS (
         SELECT 1 FROM outbox o
         WHERE o.kind = 'send' AND o.state IN ('pending', 'in_flight')
           AND o.payload->'attachments' ? u.id::text)
       AND NOT EXISTS (
         SELECT 1 FROM drafts d
         WHERE NOT d.deleted AND d.payload->'attachments' ? u.id::text)
     ORDER BY u.created_at
     LIMIT $2`,
    [olderThanHours, limit],
  )
}

export async function deleteUploads(db: Queryable, ids: string[]) {
  if (!ids.length) return
  await db.query(`DELETE FROM uploads WHERE id = ANY($1::uuid[])`, [ids])
}
