import { HttpError } from './http'
import { MAX_OPS_PER_REQUEST, type OpEnvelope, type OpsResponse } from './ops'

/** The replica's queue of pending triage ops (pending_ops on every platform). */
export interface OpQueue {
  unsentOps(limit: number): OpEnvelope[] | Promise<OpEnvelope[]>
  markOpsSent(ids: readonly string[]): void | Promise<void>
  /** Forget ops and restore server state; `keep` folds their effect in instead. */
  settleOps(ids: readonly string[], keep?: boolean): void | Promise<void>
}

export interface OpDrainOptions {
  /** POST /api/ops. Null when there is no server (demo): ops settle as if done at once. */
  send: ((ops: OpEnvelope[]) => Promise<OpsResponse>) | null
  /** False while signed out or without a token; the drain waits for the next `run()`. */
  ready?: () => boolean
  /** Ops the server refused; their threads are already back to server state. */
  onFailed?: (rows: { id: string; error: string }[]) => void
  maxBackoffMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

/**
 * Sends queued ops to the server in order, one request at a time (architecture §6.5).
 * Network trouble backs off and retries; `run()` again (online, focus, token refresh) resumes
 * at once. Accepted ops stay overlaid until a sync delta reports them done or failed.
 */
export class OpDrain {
  private running = false
  private again = false
  private retryMs = 0
  private timer: unknown
  private limit = MAX_OPS_PER_REQUEST
  private readonly setT: NonNullable<OpDrainOptions['setTimeout']>
  private readonly clearT: NonNullable<OpDrainOptions['clearTimeout']>

  constructor(
    private queue: OpQueue,
    private opts: OpDrainOptions,
  ) {
    this.setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
    this.clearT =
      opts.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  /** Drains now; a call that lands mid-drain schedules one more pass. */
  run = (): Promise<void> => {
    if (this.running) {
      this.again = true
      return Promise.resolve()
    }
    this.running = true
    this.clearT(this.timer)
    return this.loop().finally(() => {
      this.running = false
    })
  }

  private async loop(): Promise<void> {
    do {
      this.again = false
      for (;;) {
        const batch = await this.queue.unsentOps(this.limit)
        if (!batch.length) break
        const ids = batch.map((e) => e.id)
        const send = this.opts.send
        if (!send) {
          await this.queue.settleOps(ids, true)
          continue
        }
        if (this.opts.ready && !this.opts.ready()) return
        let res: OpsResponse
        try {
          res = await send(batch)
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) {
            // One malformed op must not wedge the queue: isolate it, then fail it alone.
            if (batch.length > 1) this.limit = 1
            else await this.fail([{ id: ids[0]!, error: err.message }])
            continue
          }
          this.retryMs = Math.min(
            this.opts.maxBackoffMs ?? 30_000,
            Math.max(1_000, this.retryMs * 2),
          )
          this.timer = this.setT(() => void this.run(), this.retryMs)
          return
        }
        this.retryMs = 0
        this.limit = MAX_OPS_PER_REQUEST
        const rejected = new Set(res.rejected.map((r) => r.id))
        // Anything the server didn't mention would be resent forever; it's idempotent anyway.
        await this.queue.markOpsSent(ids.filter((id) => !rejected.has(id)))
        if (res.rejected.length) await this.fail(res.rejected)
      }
    } while (this.again)
  }

  private async fail(rows: { id: string; error: string }[]) {
    await this.queue.settleOps(rows.map((r) => r.id))
    this.opts.onFailed?.(rows)
  }
}
