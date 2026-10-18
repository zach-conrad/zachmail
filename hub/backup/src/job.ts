import type { Db } from '@zachhub/db/server'
import { exportBackup } from './format'
import { S3Client, type S3Config } from './s3'

export interface BackupConfig {
  s3: S3Config
  /** Object key prefix, e.g. 'zachhub/'; each night is `<prefix><YYYY-MM-DD>.ndjson.gz`. */
  prefix: string
  retentionDays: number
  /** The job runs at or after this UTC hour, once per UTC day. */
  hourUtc: number
}

/** Null (backups off) until all four BACKUP_S3_* essentials are set. */
export function backupConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BackupConfig | null {
  const {
    BACKUP_S3_ENDPOINT: endpoint,
    BACKUP_S3_BUCKET: bucket,
    BACKUP_S3_ACCESS_KEY_ID: accessKeyId,
    BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey,
  } = env
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  const num = (k: string, fallback: number, max: number) => {
    const v = env[k]
    if (!v) return fallback
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`Invalid env: ${k}=${v}`)
    return n
  }
  const prefix = env.BACKUP_PREFIX ?? 'zachhub/'
  return {
    s3: {
      endpoint,
      bucket,
      region: env.BACKUP_S3_REGION || 'auto',
      accessKeyId,
      secretAccessKey,
    },
    prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
    retentionDays: Math.max(1, num('BACKUP_RETENTION_DAYS', 30, 3650)),
    hourUtc: num('BACKUP_HOUR_UTC', 10, 23),
  }
}

export const backupKey = (prefix: string, day: string) => `${prefix}${day}.ndjson.gz`

/** A failed night is retried on later sweeps up to this many times. */
export const MAX_ATTEMPTS = 3
/** A run still 'running' after this long died with its machine and may be taken over. */
const STALE_RUN = '1 hour'

export interface BackupRun {
  day: string
  key: string
  bytes: number
  rows: Record<string, number>
  pruned: string[]
}

/**
 * Called from the worker's housekeeping sweep. Runs tonight's backup if it is due and no
 * other machine has it; returns what it did, or null when there was nothing to do.
 */
export async function runNightlyBackup(
  db: Db,
  config: BackupConfig,
  s3 = new S3Client(config.s3),
  now = new Date(),
): Promise<BackupRun | null> {
  if (now.getUTCHours() < config.hourUtc) return null
  const day = now.toISOString().slice(0, 10)
  const [claim] = await db.query(
    `INSERT INTO backup_runs (day) VALUES ($1)
     ON CONFLICT (day) DO UPDATE
       SET status = 'running', attempts = backup_runs.attempts + 1, started_at = now(),
           finished_at = NULL, error = NULL
       WHERE (backup_runs.status = 'failed' AND backup_runs.attempts < $2)
          OR (backup_runs.status = 'running' AND backup_runs.started_at < now() - interval '${STALE_RUN}')
     RETURNING day`,
    [day, MAX_ATTEMPTS],
  )
  if (!claim) return null
  const key = backupKey(config.prefix, day)
  try {
    const { body, rows } = await exportBackup(db, { now })
    await s3.put(key, body, 'application/gzip')
    // Read it back: a backup only counts once the copy at the provider is whole.
    const stored = await s3.get(key)
    if (!stored || Buffer.compare(Buffer.from(stored), body) !== 0)
      throw new Error('Uploaded backup does not match what was sent')
    const pruned = await pruneBackups(s3, config, now)
    await db.query(
      `UPDATE backup_runs SET status = 'ok', finished_at = now(), object_key = $2, bytes = $3,
         rows = $4::jsonb WHERE day = $1`,
      [day, key, body.length, JSON.stringify(rows)],
    )
    return { day, key, bytes: body.length, rows, pruned }
  } catch (err) {
    await db.query(
      `UPDATE backup_runs SET status = 'failed', finished_at = now(), error = $2 WHERE day = $1`,
      [day, String(err instanceof Error ? err.message : err).slice(0, 2000)],
    )
    throw err
  }
}

/** Deletes nightly backups older than the retention window. Returns the deleted keys. */
export async function pruneBackups(s3: S3Client, config: BackupConfig, now = new Date()) {
  const cutoff = new Date(now.getTime() - config.retentionDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const pruned: string[] = []
  for (const o of await s3.list(config.prefix)) {
    const day = o.key.slice(config.prefix.length).match(/^(\d{4}-\d{2}-\d{2})\.ndjson\.gz$/)?.[1]
    // Only touch files this job wrote; anything else under the prefix is left alone.
    if (day && day < cutoff) {
      await s3.delete(o.key)
      pruned.push(o.key)
    }
  }
  return pruned
}

export interface BackupStatus {
  day: string
  status: 'running' | 'ok' | 'failed'
  attempts: number
  startedAt: string
  finishedAt: string | null
  objectKey: string | null
  bytes: number | null
  error: string | null
}

/** The latest run, and the latest good one (for settings and the stale-backup alert). */
export async function readBackupStatus(db: Db) {
  const select = `SELECT day::text AS day, status, attempts,
      to_json(started_at) #>> '{}' AS "startedAt", to_json(finished_at) #>> '{}' AS "finishedAt", object_key AS "objectKey", bytes, error FROM backup_runs`
  const [latest] = await db.query<BackupStatus>(`${select} ORDER BY day DESC LIMIT 1`)
  const [lastOk] = await db.query<BackupStatus>(
    `${select} WHERE status = 'ok' ORDER BY day DESC LIMIT 1`,
  )
  return { latest: latest ?? null, lastOk: lastOk ?? null }
}
