import type { BootstrapLine, Deletes, Rows, SyncDelta } from './protocol'

/** Where synced rows land: the local replica (SQLite on every platform). */
export interface SyncSink {
  getSeq(): number | null | Promise<number | null>
  /** Drop every synced row; called before a fresh bootstrap. */
  reset(): void | Promise<void>
  /** Apply rows (and deletes), and record `seq` when given, in one transaction. */
  apply(
    upserts: Partial<Rows>,
    deletes: Partial<Deletes> | null,
    seq: number | null,
  ): void | Promise<void>
}

export interface SyncTransport {
  bootstrap(signal: AbortSignal): AsyncIterable<BootstrapLine>
  delta(since: number, signal: AbortSignal): Promise<SyncDelta>
}

/** The server no longer has changes back to `since`; the client must bootstrap again. */
export class ResyncRequired extends Error {
  constructor() {
    super('Sync cursor expired; bootstrapping again')
  }
}

export interface SyncClientOptions {
  /** Called after every applied batch, so the UI can re-read local state. */
  onChange?: () => void
  onError?: (err: unknown) => void
}

/**
 * Pulls the server's change log into the local replica: bootstrap once, then deltas. `pull()`
 * is single-flight; calls that land mid-pull schedule exactly one follow-up pull.
 */
export class SyncClient {
  private running: Promise<void> | null = null
  private again = false
  private abort = new AbortController()

  constructor(
    private sink: SyncSink,
    private transport: SyncTransport,
    private opts: SyncClientOptions = {},
  ) {}

  pull(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.pullOnce()
        } while (this.again && !this.abort.signal.aborted)
      } catch (err) {
        if (!this.abort.signal.aborted) this.opts.onError?.(err)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  stop(): void {
    this.abort.abort()
  }

  private async pullOnce(): Promise<void> {
    const seq = await this.sink.getSeq()
    if (seq === null) return this.bootstrap()
    try {
      await this.deltas(seq)
    } catch (err) {
      if (!(err instanceof ResyncRequired)) throw err
      await this.bootstrap()
    }
  }

  private async bootstrap(): Promise<void> {
    await this.sink.reset()
    for await (const line of this.transport.bootstrap(this.abort.signal)) {
      if ('rows' in line) await this.sink.apply(line.rows, null, null)
      else await this.sink.apply({}, null, line.seq)
      // Chunks arrive newest first, so the inbox fills in before the stream ends.
      this.opts.onChange?.()
      await yieldToEventLoop()
    }
    const seq = await this.sink.getSeq()
    if (seq !== null) await this.deltas(seq)
  }

  private async deltas(since: number): Promise<void> {
    let seq = since
    for (;;) {
      const d = await this.transport.delta(seq, this.abort.signal)
      const empty = d.seq === seq && !d.more && isEmpty(d)
      if (!empty) {
        await this.sink.apply(d.upserts, d.deletes, d.seq)
        this.opts.onChange?.()
        await yieldToEventLoop()
      }
      seq = d.seq
      if (!d.more) return
    }
  }
}

// Lets queued reads (the UI's list queries) run between batches of a long sync.
const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0))

const isEmpty = (d: SyncDelta) =>
  Object.values(d.upserts).every((a: unknown[]) => a.length === 0) &&
  Object.values(d.deletes).every((a: unknown[]) => a.length === 0)

export interface SyncLoopOptions {
  intervalMs?: number
  /** Extra triggers (window focus, Realtime nudge, push); each returns an unsubscribe. */
  triggers?: ((pull: () => void) => () => void)[]
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}

/** Pulls now, every `intervalMs` (60 s default), and whenever a trigger fires. */
export function startSyncLoop(
  client: Pick<SyncClient, 'pull'>,
  opts: SyncLoopOptions = {},
): () => void {
  const pull = () => void client.pull()
  const set = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clear =
    opts.clearInterval ?? ((id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>))
  const timer = set(pull, opts.intervalMs ?? 60_000)
  const offs = (opts.triggers ?? []).map((t) => t(pull))
  pull()
  return () => {
    clear(timer)
    for (const off of offs) off()
  }
}
