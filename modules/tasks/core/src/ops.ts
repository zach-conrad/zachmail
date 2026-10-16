/**
 * Task ops, namespaced `tasks.*` (ZACHHUB_PLAN.md §6). A client applies an op to its replica in
 * the same frame, queues it, and sends it; the server applies the same reducer. Ops carry
 * everything they need (new rows, the next recurring instance), so client and server never
 * compute a different result from clocks or time zones.
 *
 * Updates are field patches, which is what per-field last-writer-wins merging needs: two devices
 * editing different fields of one task both keep their change.
 */
import { nextInstance } from './recurrence'
import { dateKey, daysBetween, fromDateKey } from './dates'
import type { Task, TaskList, TaskListPatch, TaskPatch } from './types'

export type TaskOp =
  | { kind: 'tasks.create'; task: Task }
  | { kind: 'tasks.update'; id: string; patch: TaskPatch }
  /** `next` is the following instance of a recurring task, built by `completeOp`. */
  | { kind: 'tasks.complete'; id: string; at: number; next?: Task }
  /** Undo of complete: restores the rule and drops the instance completing created. */
  | { kind: 'tasks.uncomplete'; id: string; rrule?: string | null; removeId?: string }
  /** Removes the task and its subtasks. */
  | { kind: 'tasks.delete'; id: string }
  /** Undo of delete: puts the rows back exactly. */
  | { kind: 'tasks.restore'; tasks: Task[] }
  | { kind: 'tasks.list.create'; list: TaskList }
  | { kind: 'tasks.list.update'; id: string; patch: TaskListPatch }
  /** Deleting a list keeps its tasks: they move to the Inbox. */
  | { kind: 'tasks.list.delete'; id: string }
  /** Undo of list delete. */
  | { kind: 'tasks.list.restore'; list: TaskList; taskIds: string[] }

export type TaskOpKind = TaskOp['kind']

export interface TasksState {
  tasks: ReadonlyMap<string, Task>
  lists: ReadonlyMap<string, TaskList>
}

export const emptyTasksState = (): TasksState => ({ tasks: new Map(), lists: new Map() })

/** Rows an op writes and removes. Stores apply this; the in-memory reducer is built on it. */
export interface TaskEffect {
  putTasks: Task[]
  removeTasks: string[]
  putLists: TaskList[]
  removeLists: string[]
}

const effect = (e: Partial<TaskEffect>): TaskEffect => ({
  putTasks: e.putTasks ?? [],
  removeTasks: e.removeTasks ?? [],
  putLists: e.putLists ?? [],
  removeLists: e.removeLists ?? [],
})

/** Read access to the current rows, so the server can back this with SQL instead of a Map. */
export interface TasksReader {
  task(id: string): Task | undefined
  list(id: string): TaskList | undefined
  /** Direct subtasks of a task. */
  children(id: string): Task[]
  tasksInList(listId: string): Task[]
}

export function stateReader(state: TasksState): TasksReader {
  return {
    task: (id) => state.tasks.get(id),
    list: (id) => state.lists.get(id),
    children: (id) => [...state.tasks.values()].filter((t) => t.parentId === id),
    tasksInList: (id) => [...state.tasks.values()].filter((t) => t.listId === id),
  }
}

/** The rows `op` changes, given the state before it. */
export function taskOpEffect(op: TaskOp, read: TasksReader): TaskEffect {
  switch (op.kind) {
    case 'tasks.create':
      return effect({ putTasks: [op.task] })
    case 'tasks.update': {
      const t = read.task(op.id)
      if (!t) return effect({})
      const next = { ...t, ...op.patch }
      // A due time without a date means nothing; clearing the date clears the time.
      if (next.dueDate === null) next.dueTime = null
      return effect({ putTasks: [next] })
    }
    case 'tasks.complete': {
      const t = read.task(op.id)
      if (!t || t.completedAt !== null) return effect({})
      // The finished instance drops its rule; the series lives on in `next`.
      const done = { ...t, completedAt: op.at, rrule: op.next ? null : t.rrule }
      return effect({ putTasks: op.next ? [done, op.next] : [done] })
    }
    case 'tasks.uncomplete': {
      const t = read.task(op.id)
      if (!t) return effect({})
      const rrule = op.rrule !== undefined ? op.rrule : t.rrule
      return effect({
        putTasks: [{ ...t, completedAt: null, rrule }],
        removeTasks: op.removeId ? [op.removeId] : [],
      })
    }
    case 'tasks.delete': {
      const t = read.task(op.id)
      if (!t) return effect({})
      return effect({ removeTasks: [t.id, ...read.children(t.id).map((c) => c.id)] })
    }
    case 'tasks.restore':
      return effect({ putTasks: op.tasks })
    case 'tasks.list.create':
      return effect({ putLists: [op.list] })
    case 'tasks.list.update': {
      const l = read.list(op.id)
      return l ? effect({ putLists: [{ ...l, ...op.patch }] }) : effect({})
    }
    case 'tasks.list.delete':
      return effect({
        removeLists: [op.id],
        putTasks: read.tasksInList(op.id).map((t) => ({ ...t, listId: null })),
      })
    case 'tasks.list.restore':
      return effect({
        putLists: [op.list],
        putTasks: op.taskIds.flatMap((id) => {
          const t = read.task(id)
          return t ? [{ ...t, listId: op.list.id }] : []
        }),
      })
  }
}

/** Applies an effect; maps are copied only when they change. */
export function applyTaskEffect(state: TasksState, e: TaskEffect): TasksState {
  let { tasks, lists } = state
  if (e.putTasks.length || e.removeTasks.length) {
    const next = new Map(tasks)
    for (const id of e.removeTasks) next.delete(id)
    for (const t of e.putTasks) next.set(t.id, t)
    tasks = next
  }
  if (e.putLists.length || e.removeLists.length) {
    const next = new Map(lists)
    for (const id of e.removeLists) next.delete(id)
    for (const l of e.putLists) next.set(l.id, l)
    lists = next
  }
  return tasks === state.tasks && lists === state.lists ? state : { tasks, lists }
}

export function applyTaskOp(state: TasksState, op: TaskOp): TasksState {
  return applyTaskEffect(state, taskOpEffect(op, stateReader(state)))
}

/**
 * The op that undoes `op`, computed from the state *before* `op` runs (it needs the old values).
 * Null when `op` would change nothing.
 */
export function invertTaskOp(op: TaskOp, read: TasksReader): TaskOp | null {
  switch (op.kind) {
    case 'tasks.create':
      return { kind: 'tasks.delete', id: op.task.id }
    case 'tasks.update': {
      const t = read.task(op.id)
      if (!t) return null
      const patch: Record<string, unknown> = {}
      for (const k of Object.keys(op.patch)) patch[k] = t[k as keyof Task]
      if ('dueDate' in op.patch && !('dueTime' in op.patch)) patch.dueTime = t.dueTime
      return { kind: 'tasks.update', id: op.id, patch: patch as TaskPatch }
    }
    case 'tasks.complete': {
      const t = read.task(op.id)
      if (!t || t.completedAt !== null) return null
      return op.next
        ? { kind: 'tasks.uncomplete', id: op.id, rrule: t.rrule, removeId: op.next.id }
        : { kind: 'tasks.uncomplete', id: op.id }
    }
    case 'tasks.uncomplete': {
      const t = read.task(op.id)
      return t?.completedAt != null
        ? { kind: 'tasks.complete', id: op.id, at: t.completedAt }
        : null
    }
    case 'tasks.delete': {
      const t = read.task(op.id)
      return t ? { kind: 'tasks.restore', tasks: [t, ...read.children(t.id)] } : null
    }
    case 'tasks.restore':
      return op.tasks[0] ? { kind: 'tasks.delete', id: op.tasks[0].id } : null
    case 'tasks.list.create':
      return { kind: 'tasks.list.delete', id: op.list.id }
    case 'tasks.list.update': {
      const l = read.list(op.id)
      if (!l) return null
      const patch: Record<string, unknown> = {}
      for (const k of Object.keys(op.patch)) patch[k] = l[k as keyof TaskList]
      return { kind: 'tasks.list.update', id: op.id, patch: patch as TaskListPatch }
    }
    case 'tasks.list.delete': {
      const l = read.list(op.id)
      if (!l) return null
      const taskIds = read.tasksInList(op.id).map((t) => t.id)
      return { kind: 'tasks.list.restore', list: l, taskIds }
    }
    case 'tasks.list.restore':
      return { kind: 'tasks.list.delete', id: op.list.id }
  }
}

/**
 * Builds the complete op for `task`. For a recurring task it also builds the next instance
 * (new id from `newId`), due on the next occurrence, with its alert moved by the same number of
 * days so "9am on the 1st" stays 9am. Returns the op and, for the toast, the next due date.
 */
export function completeOp(
  task: Task,
  now: Date,
  newId: () => string,
): { op: TaskOp; nextDue: string | null } {
  const at = now.getTime()
  if (!task.rrule) return { op: { kind: 'tasks.complete', id: task.id, at }, nextDue: null }
  const n = nextInstance(task.rrule, task.dueDate, task.dueTime, dateKey(now))
  if (!n) return { op: { kind: 'tasks.complete', id: task.id, at }, nextDue: null }
  let alertAt: number | null = null
  if (task.alertAt !== null) {
    const shift = daysBetween(task.dueDate ?? dateKey(now), n.dueDate)
    const d = new Date(task.alertAt)
    // Shift by calendar days, not 24 h steps, so a DST change keeps the wall-clock time.
    d.setDate(d.getDate() + shift)
    alertAt = d.getTime()
  }
  const next: Task = {
    ...task,
    id: newId(),
    dueDate: n.dueDate,
    rrule: n.rrule,
    alertAt,
    completedAt: null,
    createdAt: at,
  }
  return { op: { kind: 'tasks.complete', id: task.id, at, next }, nextDue: n.dueDate }
}

/** epoch ms of a task's due moment (date + time, or the date's start), for sorting and alerts. */
export const dueAt = (t: Pick<Task, 'dueDate' | 'dueTime'>) =>
  t.dueDate ? fromDateKey(t.dueDate, t.dueTime).getTime() : null
