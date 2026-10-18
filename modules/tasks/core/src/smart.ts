/**
 * Views: the smart lists (Today, Upcoming, Overdue, Flagged), the Inbox and user lists. Each is
 * a query over the local replica, never a server round trip (ZACHHUB_PLAN.md §3.2): a single
 * pass over the tasks in memory, then a sort.
 */
import type { Clock } from './dates'
import type { TasksState } from './ops'
import type { Task, TaskList } from './types'

export type SmartListKey = 'today' | 'upcoming' | 'overdue' | 'flagged'

export type TaskView =
  { kind: 'smart'; key: SmartListKey } | { kind: 'inbox' } | { kind: 'list'; id: string }

export const SMART_LISTS: readonly { key: SmartListKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'flagged', label: 'Flagged' },
]

export const isOpen = (t: Task) => t.completedAt === null

export function isOverdue(t: Task, clock: Clock): boolean {
  if (t.completedAt !== null || t.dueDate === null) return false
  if (t.dueDate < clock.today) return true
  return t.dueDate === clock.today && t.dueTime !== null && t.dueTime <= clock.time
}

export function inView(t: Task, view: TaskView, clock: Clock): boolean {
  if (t.completedAt !== null) return false
  switch (view.kind) {
    case 'inbox':
      return t.listId === null && t.parentId === null
    case 'list':
      return t.listId === view.id && t.parentId === null
    case 'smart':
      switch (view.key) {
        case 'today':
          return t.dueDate !== null && t.dueDate <= clock.today
        case 'upcoming':
          return t.dueDate !== null && t.dueDate > clock.today
        case 'overdue':
          return isOverdue(t, clock)
        case 'flagged':
          return t.priority === 3
      }
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Smart lists: by due date (undated last), timed before untimed, then priority, then manual order. */
export function compareByDue(a: Task, b: Task): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1
    if (b.dueDate === null) return -1
    return cmp(a.dueDate, b.dueDate)
  }
  if (a.dueTime !== b.dueTime) {
    if (a.dueTime === null) return 1
    if (b.dueTime === null) return -1
    return cmp(a.dueTime, b.dueTime)
  }
  return b.priority - a.priority || cmp(a.position, b.position) || cmp(a.id, b.id)
}

/** Lists and the Inbox: manual order. */
export const compareByPosition = (a: Task, b: Task) =>
  cmp(a.position, b.position) || cmp(a.id, b.id)

export const comparatorFor = (view: TaskView) =>
  view.kind === 'smart' ? compareByDue : compareByPosition

/**
 * The tasks in a view, sorted. `revive` lists completed tasks to treat as still open (rows
 * playing their exit animation), so callers never copy the whole map to keep them.
 */
export function selectTasks(
  state: TasksState,
  view: TaskView,
  clock: Clock,
  revive?: ReadonlySet<string>,
): Task[] {
  const out: Task[] = []
  for (let t of state.tasks.values()) {
    if (t.completedAt !== null && revive?.has(t.id)) t = { ...t, completedAt: null }
    if (inView(t, view, clock)) out.push(t)
  }
  return out.sort(comparatorFor(view))
}

/** Open subtasks of a parent, in manual order. */
export function selectSubtasks(state: TasksState, parentId: string): Task[] {
  const out: Task[] = []
  for (const t of state.tasks.values()) if (t.parentId === parentId && isOpen(t)) out.push(t)
  return out.sort(compareByPosition)
}

/** Open subtasks of every parent in one pass, each list in manual order. */
export function subtasksByParent(
  state: TasksState,
  revive?: ReadonlySet<string>,
): Map<string, Task[]> {
  const out = new Map<string, Task[]>()
  for (let t of state.tasks.values()) {
    const parent = t.parentId
    if (parent === null) continue
    if (t.completedAt !== null) {
      if (!revive?.has(t.id)) continue
      t = { ...t, completedAt: null }
    }
    const list = out.get(parent)
    if (list) list.push(t)
    else out.set(parent, [t])
  }
  for (const list of out.values()) list.sort(compareByPosition)
  return out
}

export function sortedLists(state: TasksState): TaskList[] {
  return [...state.lists.values()].sort((a, b) => cmp(a.position, b.position) || cmp(a.id, b.id))
}

export interface ViewCounts {
  today: number
  upcoming: number
  overdue: number
  flagged: number
  inbox: number
  lists: Map<string, number>
}

/** Every sidebar badge in one pass over the tasks. */
export function countViews(state: TasksState, clock: Clock): ViewCounts {
  const c: ViewCounts = {
    today: 0,
    upcoming: 0,
    overdue: 0,
    flagged: 0,
    inbox: 0,
    lists: new Map(),
  }
  for (const t of state.tasks.values()) {
    if (t.completedAt !== null) continue
    if (t.dueDate !== null) {
      if (t.dueDate <= clock.today) c.today++
      else c.upcoming++
      if (isOverdue(t, clock)) c.overdue++
    }
    if (t.priority === 3) c.flagged++
    if (t.parentId === null) {
      if (t.listId === null) c.inbox++
      else c.lists.set(t.listId, (c.lists.get(t.listId) ?? 0) + 1)
    }
  }
  return c
}
