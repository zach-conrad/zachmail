/**
 * The tasks replica on this device. Ops apply to in-memory state in the same frame (optimistic),
 * queue in `pending` for the sync drain, and push their inverse on the undo stack. Until the
 * server tables and sync land, state persists to localStorage so tasks survive a reload; the
 * pending queue is what will be sent once /api/ops accepts `tasks.*` ops.
 */
import {
  applyTaskOp,
  emptyTasksState,
  invertTaskOp,
  stateReader,
  type Task,
  type TaskList,
  type TaskOp,
  type TasksState,
} from '@zachhub/tasks-core'

export interface PendingTaskOp {
  id: string
  op: TaskOp
  at: number
}

export interface TasksToast {
  key: number
  text: string
  undo: boolean
}

const STORAGE_KEY = 'zh.tasks.v1'
const MAX_UNDO = 50
const TOAST_MS = 6000

interface Persisted {
  tasks: Task[]
  lists: TaskList[]
  pending: PendingTaskOp[]
}

export const newId = () => crypto.randomUUID()

function load(): Persisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Persisted) : null
  } catch {
    return null
  }
}

export class TasksStore {
  private state: TasksState
  private version = 0
  private listeners = new Set<() => void>()
  private undoStack: TaskOp[] = []
  private toastTimer: ReturnType<typeof setTimeout> | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private toastKey = 0
  toast: TasksToast | null = null
  pending: PendingTaskOp[] = []

  /** `persist: false` keeps everything in memory (demo fixture, tests). */
  constructor(
    initial?: TasksState,
    private persist = initial === undefined,
  ) {
    const saved = persist ? load() : null
    if (saved) {
      this.state = {
        tasks: new Map(saved.tasks.map((t) => [t.id, t])),
        lists: new Map(saved.lists.map((l) => [l.id, l])),
      }
      this.pending = saved.pending
    } else this.state = initial ?? emptyTasksState()
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
    const inverse = invertTaskOp(op, stateReader(this.state))
    const at = Date.now()
    const next = applyTaskOp(this.state, op, at)
    if (next === this.state) return false
    this.state = next
    this.pending.push({ id: newId(), op, at })
    if (inverse) {
      this.undoStack.push(inverse)
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift()
    }
    if (toast) this.showToast(toast, !!inverse)
    this.emit()
    this.scheduleSave()
    return true
  }

  undo(): boolean {
    const inverse = this.undoStack.pop()
    if (!inverse) return false
    const at = Date.now()
    this.state = applyTaskOp(this.state, inverse, at)
    this.pending.push({ id: newId(), op: inverse, at })
    this.showToast('Undone', false)
    this.emit()
    this.scheduleSave()
    return true
  }

  private showToast(text: string, undo: boolean) {
    this.toast = { key: ++this.toastKey, text, undo }
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => {
      this.toast = null
      this.emit()
    }, TOAST_MS)
  }

  // Writes happen off the interaction: a 5k-task JSON write must never land in a keypress.
  private scheduleSave() {
    if (!this.persist || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      const save = () => {
        try {
          const data: Persisted = {
            tasks: [...this.state.tasks.values()],
            lists: [...this.state.lists.values()],
            pending: this.pending,
          }
          localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
        } catch {
          // Storage full or blocked: state still lives in memory for this session.
        }
      }
      if ('requestIdleCallback' in window) requestIdleCallback(save, { timeout: 2000 })
      else save()
    }, 300)
  }
}
