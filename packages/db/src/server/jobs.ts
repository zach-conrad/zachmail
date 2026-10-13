import type { Queryable } from './sql'

export interface EnqueueArgs {
  userId: string
  kind: string
  payload?: Record<string, unknown>
  /** At most one pending job per key; later enqueues with the same key are dropped. */
  dedupeKey?: string
  runAt?: Date
}

export async function enqueueJob(db: Queryable, job: EnqueueArgs): Promise<void> {
  await db.query(
    `INSERT INTO jobs (user_id, kind, payload, dedupe_key, run_at)
     VALUES ($1, $2, $3::jsonb, $4, COALESCE($5::timestamptz, now()))
     ON CONFLICT (dedupe_key) WHERE locked_by IS NULL AND dedupe_key IS NOT NULL DO NOTHING`,
    [
      job.userId,
      job.kind,
      job.payload ?? {},
      job.dedupeKey ?? null,
      job.runAt?.toISOString() ?? null,
    ],
  )
}
