import type { ThreadDetail } from '@zachmail/local-store'
import type { DataClient } from './client'

const MAX = 64
const PREFETCH_DELAY_MS = 40

/** Recently used thread details on the main thread, so opening a warmed thread is synchronous. */
export class ThreadCache {
  private map = new Map<string, ThreadDetail>()
  private inflight = new Map<string, Promise<ThreadDetail | null>>()
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  version = 0

  constructor(private data: DataClient) {}

  get(id: string): ThreadDetail | undefined {
    const d = this.map.get(id)
    if (d) {
      this.map.delete(id)
      this.map.set(id, d)
    }
    return d
  }

  load(id: string): Promise<ThreadDetail | null> {
    let p = this.inflight.get(id)
    if (!p) {
      p = this.data.api.getThread(id).then((d) => {
        this.inflight.delete(id)
        if (d) {
          this.put(id, d)
          this.emit()
        }
        return d
      })
      this.inflight.set(id, p)
    }
    return p
  }

  /**
   * Warm details and bodies for threads likely to open next. Debounced so holding J doesn't
   * queue work for every thread flown past; only where focus rests gets warmed.
   */
  prefetch(ids: readonly string[]) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      for (const id of ids) if (!this.map.has(id)) void this.load(id)
      void this.data.api.ensureBodies([...ids])
    }, PREFETCH_DELAY_MS)
  }

  /**
   * The replica changed under these threads (all when null). Stale entries are dropped,
   * except `keep` (the open and focused threads), which are re-read in place without flicker.
   */
  invalidate(ids: readonly string[] | null, keep: readonly string[] = []) {
    for (const id of ids ?? [...this.map.keys()]) if (!keep.includes(id)) this.map.delete(id)
    for (const id of keep) {
      if (ids && !ids.includes(id)) continue
      void this.data.api.getThread(id).then((d) => {
        if (d) this.put(id, d)
        else this.map.delete(id)
        this.emit()
      })
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = () => this.version

  private put(id: string, d: ThreadDetail) {
    this.map.delete(id)
    this.map.set(id, d)
    if (this.map.size > MAX) this.map.delete(this.map.keys().next().value!)
  }

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}
