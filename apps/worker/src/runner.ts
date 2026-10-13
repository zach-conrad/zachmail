import type { ClaimedJob, Queue } from './queue'

export type JobHandler = (job: ClaimedJob) => Promise<void>

/** Exponential backoff with jitter: ~2s, 4s, 8s … capped at 10 min. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(2 ** attempt * 1000, 10 * 60 * 1000)
  return Math.round(base * (0.75 + random() * 0.5))
}

export interface RunnerOptions {
  workerId: string
  queue: Queue
  handlers: Record<string, JobHandler>
  concurrency?: number
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

/**
 * Claims ready jobs and runs them. `tick()` drains everything currently ready; the caller
 * decides when to tick (on NOTIFY, and on a fallback poll).
 */
export class Runner {
  private running = 0
  private draining: Promise<void> | null = null
  private again = false

  constructor(private opts: RunnerOptions) {}

  get busy() {
    return this.running
  }

  tick(): Promise<void> {
    if (this.draining) {
      this.again = true
      return this.draining
    }
    this.draining = this.drain().finally(() => {
      this.draining = null
      if (this.again) {
        this.again = false
        void this.tick()
      }
    })
    return this.draining
  }

  private async drain() {
    const { queue, workerId, concurrency = 4 } = this.opts
    for (;;) {
      const jobs = await queue.claim(workerId, concurrency)
      if (jobs.length === 0) return
      await Promise.all(jobs.map((j) => this.run(j)))
    }
  }

  private async run(job: ClaimedJob) {
    const { queue, handlers, log = () => {} } = this.opts
    const handler = handlers[job.kind]
    this.running++
    try {
      if (!handler) throw new Error(`No handler for job kind "${job.kind}"`)
      await handler(job)
      await queue.complete(job.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const retry = job.attempts < job.maxAttempts ? backoffMs(job.attempts) : null
      log('job failed', {
        id: job.id,
        kind: job.kind,
        attempts: job.attempts,
        retry,
        error: message,
      })
      await queue.fail(job, message, retry)
    } finally {
      this.running--
    }
  }
}
