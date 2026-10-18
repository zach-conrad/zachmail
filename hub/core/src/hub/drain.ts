import { HttpError } from '../sync/http'
import {
  MAX_ENTITY_OPS_PER_REQUEST,
  type EntityOp,
  type EntityOpsRequest,
  type EntityOpsResponse,
} from './entities'

/** An unsent entity write as the replica queued it (hub_entity_ops on every platform). */
export interface PendingEntityOp {
  seq: number
  op: EntityOp
}

export interface EntityDrainOptions {
  /** Queued ops, oldest first. */
  pending(limit: number): PendingEntityOp[] | Promise<PendingEntityOp[]>
  /** Forget these ops: the server has them (or refused them for good). */
  ack(seqs: readonly number[]): void | Promise<void>
  /** POST /api/entities. Demo mode passes one that accepts everything. */
  send(req: EntityOpsRequest): Promise<EntityOpsResponse>
  /** False while signed out or without a token; the drain waits for the next `run()`. */
  ready?: () => boolean
  /** Ops the server refused; they are dropped, and the row refetches on its next change. */
  onRejected?: (rows: { op: EntityOp; error: string }[]) => void
  maxBackoffMs?: number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (id: unknown) => void
}

/**
 * Sends queued entity writes to the server in order, one request at a time. Writes are stamped
 * and idempotent, so anything the server answered is acked, accepted or not; network trouble
 * and 5xx back off and retry, and `run()` again (online, focus, token refresh) resumes at once.
 */
export class EntityDrain {
  private running = false
  private again = false
  private retryMs = 0
  private timer: unknown
  private limit = MAX_ENTITY_OPS_PER_REQUEST
  private readonly setT: NonNullable<EntityDrainOptions['setTimeout']>
  private readonly clearT: NonNullable<EntityDrainOptions['clearTimeout']>

  constructor(private opts: EntityDrainOptions) {
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
        const batch = await this.opts.pending(this.limit)
        if (!batch.length) break
        if (this.opts.ready && !this.opts.ready()) return
        let res: EntityOpsResponse
        try {
          res = await this.opts.send({ ops: batch.map((p) => p.op) })
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) {
            // One malformed op must not wedge the queue: isolate it, then reject it alone.
            if (batch.length > 1) this.limit = 1
            else await this.settle(batch, [{ index: 0, error: err.message }])
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
        this.limit = MAX_ENTITY_OPS_PER_REQUEST
        // Anything the server didn't mention would be resent forever; it's idempotent anyway.
        await this.settle(batch, res.rejected)
      }
    } while (this.again)
  }

  private async settle(batch: PendingEntityOp[], rejected: EntityOpsResponse['rejected']) {
    await this.opts.ack(batch.map((p) => p.seq))
    const rows = rejected
      .filter((r) => batch[r.index])
      .map((r) => ({ op: batch[r.index]!.op, error: r.error }))
    if (rows.length) this.opts.onRejected?.(rows)
  }
}
