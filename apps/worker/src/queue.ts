import type { Sql } from 'postgres'

export interface ClaimedJob {
  id: number
  userId: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

export interface Queue {
  claim(worker: string, n: number): Promise<ClaimedJob[]>
  complete(id: number): Promise<void>
  /** Re-queue with a delay, or park it for good once attempts are exhausted. */
  fail(job: ClaimedJob, error: string, retryInMs: number | null): Promise<void>
  reapStale(): Promise<number>
}

export function pgQueue(sql: Sql): Queue {
  return {
    async claim(worker, n) {
      const rows = await sql<
        {
          id: string
          user_id: string
          kind: string
          payload: Record<string, unknown>
          attempts: number
          max_attempts: number
        }[]
      >`select * from claim_jobs(${worker}, ${n})`
      return rows.map((r) => ({
        id: Number(r.id),
        userId: r.user_id,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
      }))
    },
    async complete(id) {
      await sql`delete from jobs where id = ${id}`
    },
    async fail(job, error, retryInMs) {
      if (retryInMs === null) {
        // Dead letter: stays locked so it is never claimed again, but visible for inspection.
        await sql`update jobs set locked_by = 'dead', last_error = ${error} where id = ${job.id}`
      } else {
        await sql`
          update jobs
          set locked_by = null, locked_at = null, last_error = ${error},
              run_at = now() + make_interval(secs => ${retryInMs / 1000})
          where id = ${job.id}`
      }
    },
    async reapStale() {
      const [row] = await sql<{ n: number }[]>`select reap_stale_jobs() as n`
      return row?.n ?? 0
    },
  }
}
