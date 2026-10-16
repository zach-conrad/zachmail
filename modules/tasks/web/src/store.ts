/**
 * The tasks state on screen. Ops apply to in-memory state in the same frame (optimistic) and push
 * their inverse on the undo stack. With a backend, each op's effect also becomes entity writes
 * on the hub replica (changed fields only, so per-field merge keeps other devices' edits), and
 * the replica is re-read whenever it changes: sync deltas, other tabs, our own writes landing.
 * Without one (demo fixture, tests) everything stays in memory.
 */
import {
  applyTaskEffect,
  effectToWrites,
  emptyTasksState,
  invertTaskOp,
  listFromEntity,
  stateReader,
  taskFromEntity,
  taskOpEffect,
  LIST_ENTITY,
  LIST_FIELDS,
  TASK_ENTITY,
  TASK_FIELDS,
  type Task,
  type TaskEntityWrite,
  type TaskList,
  type TaskOp,
  type TasksState,
} from '@zachhub/tasks-core'

export interface TasksToast {
  key: number
  text: string
  undo: boolean
}

type Row = { id: string; [field: string]: unknown }

/** Where tasks live: the hub replica (web: the data worker's `entities` / `entityWrite`). */
export interface TasksBackend {
  /** Every row of `kind`, unsent local writes included. */
  read(kind: string): Promise<Row[]>
  /** Applies to the replica and queues for the server, in call order. Rejects if refused. */
  write(writes: TaskEntityWrite[]): Promise<unknown>
  /** Calls `fn` when replica rows may have changed. Returns the unsubscribe. */
  onChange(fn: () => void): () => void
}

const MAX_UNDO = 50
const TOAST_MS = 6000

export const newId = () => crypto.randomUUID()

const same = (a: unknown, b: unknown) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.join('\u0000') === b.join('\u0000'))

/** Keeps `old` when nothing in it changed, so memoized rows don't re-render on a re-read. */
function keep<T extends object>(old: T | undefined, next: T, fields: readonly string[]): T {
  if (!old) return next
  const o = old as Record<string, unknown>
  const n = next as Record<string, unknown>
  for (const f of fields) if (!same(o[f], n[f])) return next
  return old
}

export class TasksStore {
  private state: TasksState
  private version = 0
  private listeners = new Set<() => void>()
  private undoStack: TaskOp[] = []
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private toastKey = 0
  /** Bumped on every local write; a re-read issued before the latest write is stale. */
  private writes = 0
  private reading = false
  private rereadAfter = false
  toast: TasksToast | null = null
  /** False until a backend's first read lands (always true in memory). */
  loaded: boolean

  constructor(
    initial?: TasksState,
    private backend?: TasksBackend,
  ) {
    this.state = initial ?? emptyTasksState()
    this.loaded = !backend
    if (backend) {
      backend.onChange(() => this.reread())
      this.reread()
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }
  getVersion = () => this.version
  getState = () => this.state
  getToast = () => this.toast

  private emit() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  /** Applies `op` now. With `toast`, shows it with Undo. Returns false if nothing changed. */
  run(op: TaskOp, toast?: string): boolean {
    const read = stateReader(this.state)
    const inverse = invertTaskOp(op, read)
    if (!this.apply(op)) return false
    if (inverse) {
      this.undoStack.push(inverse)
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    }
    if (toast) this.showToast(toast, !!inverse)
    this.emit()
    return true
  }

  undo(): boolean {
    const inverse = this.undoStack.pop()
    if (!inverse) return false
    this.apply(inverse)
    this.showToast('Undone', false)
    this.emit()
    return true
  }

  private apply(op: TaskOp): boolean {
    const read = stateReader(this.state)
    const effect = taskOpEffect(op, read)
    const next = applyTaskEffect(this.state, effect)
    if (next === this.state) return false
    this.state = next
    if (this.backend) {
      const writes = effectToWrites(effect, read)
      if (writes.length) {
        this.writes++
        // A refused write never reached the replica: put the screen back to what it holds.
        this.backend.write(writes).catch(() => this.reread())
      }
    }
    return true
  }

  /** Re-reads the replica, one read at a time; a read raced by a local write is dropped. */
  private reread() {
    const backend = this.backend
    if (!backend) return
    if (this.reading) {
      this.rereadAfter = true
      return
    }
    this.reading = true
    const issuedAt = this.writes
    void Promise.all([backend.read(TASK_ENTITY), backend.read(LIST_ENTITY)])
      .then(([tasks, lists]) => {
        // A newer local write is in state but not in this read; the read after it will be.
        if (issuedAt !== this.writes && this.loaded) return
        const before = this.state
        const nextTasks = new Map<string, Task>()
        for (const row of tasks) {
          const t = taskFromEntity(row)
          if (t) nextTasks.set(t.id, keep(before.tasks.get(t.id), t, TASK_FIELDS))
        }
        const nextLists = new Map<string, TaskList>()
        for (const row of lists) {
          const l = listFromEntity(row)
          if (l) nextLists.set(l.id, keep(before.lists.get(l.id), l, LIST_FIELDS))
        }
        const unchanged = <V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>) =>
          a.size === b.size && [...b].every(([id, v]) => a.get(id) === v)
        const tasksSame = unchanged(before.tasks, nextTasks)
        const listsSame = unchanged(before.lists, nextLists)
        const firstLoad = !this.loaded
        this.loaded = true
        if (tasksSame && listsSame && !firstLoad) return
        this.state = {
          tasks: tasksSame ? before.tasks : nextTasks,
          lists: listsSame ? before.lists : nextLists,
        }
        this.emit()
      })
      .catch(() => {
        // The replica is unavailable (worker restarting); the next change event retries.
      })
      .finally(() => {
        this.reading = false
        if (this.rereadAfter) {
          this.rereadAfter = false
          this.reread()
        }
      })
  }

  private showToast(text: string, undo: boolean) {
    this.toast = { key: ++this.toastKey, text, undo }
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toast = null
      this.emit()
    }, TOAST_MS)
  }
}
