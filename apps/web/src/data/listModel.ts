import type { ListQuery, ThreadListItem } from '@zachmail/local-store'
import type { DataClient } from './client'

const PAGE = 100

/**
 * The rows of one inbox view, paged in from the worker around what is on screen. Reads are
 * synchronous so rendering and j/k never wait on the worker; refreshes swap pages atomically.
 */
export class ListModel {
  count: number | null = null
  version = 0
  private pages = new Map<number, ThreadListItem[]>()
  private loading = new Set<number>()
  private window: [number, number] = [0, 0]
  private gen = 0
  private refreshing = false
  private dirty = false
  private listeners = new Set<() => void>()

  constructor(
    private data: DataClient,
    readonly query: ListQuery,
  ) {
    void this.refresh()
  }

  get(i: number): ThreadListItem | undefined {
    return this.pages.get(Math.floor(i / PAGE))?.[i % PAGE]
  }

  /** Rows [start, end) are about to render; load their pages (and one either side). */
  ensure(start: number, end: number) {
    const first = Math.max(0, Math.floor(start / PAGE) - 1)
    const last = Math.floor(Math.max(start, end - 1) / PAGE) + 1
    this.window = [first, last]
    for (let p = first; p <= last; p++) {
      if (this.count !== null && p * PAGE >= this.count) break
      if (!this.pages.has(p) && !this.loading.has(p)) void this.load(p)
    }
  }

  /** Re-read count and on-screen pages after the replica changed. Coalesces bursts. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      this.dirty = true
      return
    }
    this.refreshing = true
    try {
      do {
        this.dirty = false
        const gen = ++this.gen
        const [first, last] = this.window
        const nums = Array.from({ length: last - first + 1 }, (_, i) => first + i)
        const [count, ...rows] = await Promise.all([
          this.data.api.countThreads(this.query),
          ...nums.map((p) => this.data.api.listThreads(this.query, p * PAGE, PAGE)),
        ])
        if (gen !== this.gen) continue
        this.count = count
        this.pages = new Map(nums.map((p, i) => [p, rows[i]!]))
        this.emit()
      } while (this.dirty)
    } finally {
      this.refreshing = false
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = () => this.version

  private async load(p: number) {
    this.loading.add(p)
    const gen = this.gen
    try {
      const rows = await this.data.api.listThreads(this.query, p * PAGE, PAGE)
      if (gen === this.gen) {
        this.pages.set(p, rows)
        this.emit()
      }
    } finally {
      this.loading.delete(p)
    }
  }

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}
