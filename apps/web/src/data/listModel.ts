import type { ListQuery, ThreadListItem } from '@zachmail/local-store'
import type { DataClient } from './client'

const PAGE = 100

export interface Removed {
  index: number
  item: ThreadListItem
}

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

  // ---- Optimistic edits: same-frame changes ahead of the worker's authoritative refresh ----

  /** Takes rows out of the list now; returns them with their positions for `restore`. */
  remove(ids: ReadonlySet<string>): Removed[] {
    const removed: Removed[] = []
    const rows = this.loaded()
    for (const [i, item] of rows) if (ids.has(item.id)) removed.push({ index: i, item })
    if (!removed.length) return removed
    let k = 0
    this.rebuild(
      rows.flatMap(([i, item]) => {
        if (k < removed.length && removed[k]!.index === i) {
          k++
          return []
        }
        return [[i - k, item] as const]
      }),
      -removed.length,
    )
    return removed
  }

  /** Puts rows back where `remove` took them from (undo). */
  restore(removed: readonly Removed[]) {
    const sorted = [...removed].sort((a, b) => a.index - b.index)
    const out: [number, ThreadListItem][] = []
    let k = 0
    for (const [i, item] of this.loaded()) {
      while (k < sorted.length && sorted[k]!.index <= i + k) {
        out.push([sorted[k]!.index, sorted[k]!.item])
        k++
      }
      out.push([i + k, item])
    }
    for (; k < sorted.length; k++) out.push([sorted[k]!.index, sorted[k]!.item])
    this.rebuild(out, sorted.length)
  }

  /** Rewrites loaded rows in place (read, star). */
  patch(ids: ReadonlySet<string>, fn: (item: ThreadListItem) => ThreadListItem) {
    let hit = false
    for (const rows of this.pages.values())
      rows.forEach((item, i) => {
        if (item && ids.has(item.id)) {
          rows[i] = fn(item)
          hit = true
        }
      })
    if (hit) this.invalidateInflight()
    if (hit) this.emit()
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

  private loaded(): [number, ThreadListItem][] {
    const out: [number, ThreadListItem][] = []
    for (const p of [...this.pages.keys()].sort((a, b) => a - b))
      this.pages.get(p)!.forEach((item, i) => item && out.push([p * PAGE + i, item]))
    return out
  }

  private rebuild(rows: readonly (readonly [number, ThreadListItem])[], delta: number) {
    // Rows shifted across page boundaries; a page edge left without its neighbour renders a
    // placeholder for the moment until the worker's refresh lands.
    const pages = new Map<number, ThreadListItem[]>()
    for (const [i, item] of rows) {
      const p = Math.floor(i / PAGE)
      let page = pages.get(p)
      if (!page) pages.set(p, (page = []))
      page[i % PAGE] = item
    }
    this.pages = pages
    if (this.count !== null) this.count = Math.max(0, this.count + delta)
    this.invalidateInflight()
    this.emit()
  }

  /** Reads issued before an optimistic edit would undo it; drop them and read again. */
  private invalidateInflight() {
    this.gen++
    this.loading.clear()
    if (this.refreshing) this.dirty = true
  }

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}
