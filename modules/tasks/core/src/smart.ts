/**
 * Views: the smart lists (Today, Upcoming, Overdue, Flagged), the Inbox and user lists. Each is
 * a query over the local replica, never a server round trip (ZACHHUB_PLAN.md §3.2). The same
 * view is expressed twice, as a predicate + comparator for in-memory state and as SQL for the
 * SQLite replica; tests hold the two to the same answers.
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

export function selectTasks(state: TasksState, view: TaskView, clock: Clock): Task[] {
  const out: Task[] = []
  for (const t of state.tasks.values()) if (inView(t, view, clock)) out.push(t)
  return out.sort(comparatorFor(view))
}

/** Open subtasks of a parent, in manual order. */
export function selectSubtasks(state: TasksState, parentId: string): Task[] {
  const out: Task[] = []
  for (const t of state.tasks.values()) if (t.parentId === parentId && isOpen(t)) out.push(t)
  return out.sort(compareByPosition)
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

// --- Local replica (SQLite) -------------------------------------------------------------------

/** DDL for the tasks tables in the client's SQLite replica, registered with local-store. */
export const TASKS_LOCAL_DDL = [
  `CREATE TABLE IF NOT EXISTS tasks_task (
    id TEXT PRIMARY KEY,
    list_id TEXT,
    parent_id TEXT,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    due_date TEXT,
    due_time TEXT,
    alert_at INTEGER,
    rrule TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    tags TEXT NOT NULL DEFAULT '[]',
    position TEXT NOT NULL,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS tasks_task_open_due ON tasks_task (due_date, due_time)
    WHERE completed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS tasks_task_open_list ON tasks_task (list_id, position)
    WHERE completed_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS tasks_task_parent ON tasks_task (parent_id) WHERE parent_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS tasks_list (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    position TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
] as const

export interface TaskSqlRow {
  id: string
  list_id: string | null
  parent_id: string | null
  title: string
  notes: string
  due_date: string | null
  due_time: string | null
  alert_at: number | null
  rrule: string | null
  priority: number
  tags: string
  position: string
  completed_at: number | null
  created_at: number
  updated_at: number
}

export const taskFromRow = (r: TaskSqlRow): Task => ({
  id: r.id,
  listId: r.list_id,
  parentId: r.parent_id,
  title: r.title,
  notes: r.notes,
  dueDate: r.due_date,
  dueTime: r.due_time,
  alertAt: r.alert_at,
  rrule: r.rrule,
  priority: Math.max(0, Math.min(3, r.priority)) as Task['priority'],
  tags: JSON.parse(r.tags) as string[],
  position: r.position,
  completedAt: r.completed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const taskToRow = (t: Task): TaskSqlRow => ({
  id: t.id,
  list_id: t.listId,
  parent_id: t.parentId,
  title: t.title,
  notes: t.notes,
  due_date: t.dueDate,
  due_time: t.dueTime,
  alert_at: t.alertAt,
  rrule: t.rrule,
  priority: t.priority,
  tags: JSON.stringify(t.tags),
  position: t.position,
  completed_at: t.completedAt,
  created_at: t.createdAt,
  updated_at: t.updatedAt,
})

const ORDER_BY_DUE =
  'ORDER BY due_date IS NULL, due_date, due_time IS NULL, due_time, priority DESC, position, id'
const ORDER_BY_POSITION = 'ORDER BY position, id'

/** SELECT for a view over `tasks_task`; same rows and order as `selectTasks`. */
export function viewSql(
  view: TaskView,
  clock: Clock,
): { sql: string; params: (string | number)[] } {
  const base = 'SELECT * FROM tasks_task WHERE completed_at IS NULL'
  switch (view.kind) {
    case 'inbox':
      return {
        sql: `${base} AND list_id IS NULL AND parent_id IS NULL ${ORDER_BY_POSITION}`,
        params: [],
      }
    case 'list':
      return {
        sql: `${base} AND list_id = ? AND parent_id IS NULL ${ORDER_BY_POSITION}`,
        params: [view.id],
      }
    case 'smart':
      switch (view.key) {
        case 'today':
          return { sql: `${base} AND due_date <= ? ${ORDER_BY_DUE}`, params: [clock.today] }
        case 'upcoming':
          return { sql: `${base} AND due_date > ? ${ORDER_BY_DUE}`, params: [clock.today] }
        case 'overdue':
          return {
            sql: `${base} AND (due_date < ? OR (due_date = ? AND due_time <= ?)) ${ORDER_BY_DUE}`,
            params: [clock.today, clock.today, clock.time],
          }
        case 'flagged':
          return { sql: `${base} AND priority = 3 ${ORDER_BY_DUE}`, params: [] }
      }
  }
}
