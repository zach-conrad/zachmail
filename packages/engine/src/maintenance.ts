import type { Db } from '@zachmail/db/server'
import { deleteUploads, orphanedUploads, staleSyncAccounts } from '@zachmail/db/server'
import { enqueueSync } from './jobs'
import type { Storage } from './storage'

/** Uploads nothing references after a day are dropped from storage, then from the table. */
export const UPLOAD_TTL_HOURS = 24
/** Syncs run on provider push; an account quiet this long gets a safety-net sync. */
export const POLL_SYNC_MINUTES = 30
/** Quiet this long despite safety-net syncs means sync is broken: alert. */
export const STALE_SYNC_MINUTES = 120

/** Deletes orphaned uploads in batches. Returns how many went. */
export async function sweepUploads(db: Db, storage: Storage, batch = 100): Promise<number> {
  let total = 0
  for (;;) {
    const rows = await orphanedUploads(db, UPLOAD_TTL_HOURS, batch)
    if (!rows.length) return total
    await storage.remove(rows.map((r) => r.storageKey))
    await deleteUploads(
      db,
      rows.map((r) => r.id),
    )
    total += rows.length
    if (rows.length < batch) return total
  }
}

/**
 * Enqueues a sync for every account push hasn't woken in a while (a dropped Pub/Sub message
 * must never leave the inbox stale) and returns the accounts quiet long enough to alert on.
 */
export async function sweepSyncs(db: Db) {
  for (const a of await staleSyncAccounts(db, POLL_SYNC_MINUTES))
    await enqueueSync(db, a.userId, a.id)
  return staleSyncAccounts(db, STALE_SYNC_MINUTES)
}
