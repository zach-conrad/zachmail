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
