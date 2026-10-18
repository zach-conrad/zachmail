/**
 * Tasks as hub first-party entities (hub/core hub/entities.ts). The replica and the server keep
 * rows of kinds 'tasks.task' and 'tasks.list' whose fields are exactly `Task` and `TaskList`
 * minus `id`. An op's effect becomes entity writes carrying only the fields that changed, so
 * per-field last-writer-wins merging keeps edits made to other fields on other devices.
 */
import type { TaskEffect, TasksReader } from './ops'
import type { Priority, Task, TaskList } from './types'

export const TASK_ENTITY = 'tasks.task'
export const LIST_ENTITY = 'tasks.list'

/** Same shape as local-store's EntityWrite, without depending on it. */
export type TaskEntityWrite =
  | { kind: 'put'; entity: string; id: string; fields: Record<string, unknown> }
  | { kind: 'delete'; entity: string; id: string }

export const TASK_FIELDS = [
  'listId',
  'parentId',
  'title',
  'notes',
  'dueDate',
  'dueTime',
  'alertAt',
  'rrule',
  'priority',
  'tags',
  'position',
  'completedAt',
  'createdAt',
] as const satisfies readonly (keyof Task)[]

export const LIST_FIELDS = [
  'name',
  'color',
  'position',
  'createdAt',
] as const satisfies readonly (keyof TaskList)[]

const same = (a: unknown, b: unknown) =>
  a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b))

function diff<T extends { id: string }>(
  entity: string,
  fields: readonly (keyof T & string)[],
  next: T,
  before: T | undefined,
): TaskEntityWrite | null {
  const changed: Record<string, unknown> = {}
  for (const f of fields) if (!before || !same(before[f], next[f])) changed[f] = next[f]
  return Object.keys(changed).length ? { kind: 'put', entity, id: next.id, fields: changed } : null
}

/** The entity writes for an effect, given the rows as they were before it. */
export function effectToWrites(e: TaskEffect, before: TasksReader): TaskEntityWrite[] {
  const out: TaskEntityWrite[] = []
  for (const l of e.putLists) {
    const w = diff(LIST_ENTITY, LIST_FIELDS, l, before.list(l.id))
    if (w) out.push(w)
  }
  for (const t of e.putTasks) {
    const w = diff(TASK_ENTITY, TASK_FIELDS, t, before.task(t.id))
    if (w) out.push(w)
  }
  for (const id of e.removeTasks) out.push({ kind: 'delete', entity: TASK_ENTITY, id })
  for (const id of e.removeLists) out.push({ kind: 'delete', entity: LIST_ENTITY, id })
  return out
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback)
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * A replica row as a Task. Rows can be partial (a put from another device whose create hasn't
 * arrived yet), so every field has a safe default; rows without a title are skipped.
 */
export function taskFromEntity(row: { id: string; [f: string]: unknown }): Task | null {
  if (typeof row.title !== 'string') return null
  const p = row.priority
  return {
    id: row.id,
    listId: strOrNull(row.listId),
    parentId: strOrNull(row.parentId),
    title: row.title,
    notes: str(row.notes),
    dueDate: strOrNull(row.dueDate),
    dueTime: strOrNull(row.dueTime),
    alertAt: numOrNull(row.alertAt),
    rrule: strOrNull(row.rrule),
    priority: (p === 1 || p === 2 || p === 3 ? p : 0) as Priority,
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [],
    position: str(row.position, 'a0'),
    completedAt: numOrNull(row.completedAt),
    createdAt: numOrNull(row.createdAt) ?? 0,
  }
}

export function listFromEntity(row: { id: string; [f: string]: unknown }): TaskList | null {
  if (typeof row.name !== 'string') return null
  return {
    id: row.id,
    name: row.name,
    color: str(row.color, 'gray'),
    position: str(row.position, 'a0'),
    createdAt: numOrNull(row.createdAt) ?? 0,
  }
}
