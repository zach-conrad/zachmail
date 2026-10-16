/**
 * The tasks module's first-party entity declarations: which client fields map to which columns,
 * plus the checks the kernel's type checks can't express. Field names match tasks-core's `Task`
 * and `TaskList` exactly (a test holds them together).
 */
import type { EntityTable } from '@zachhub/db/server'

export const TASK_KIND = 'tasks.task'
export const LIST_KIND = 'tasks.list'

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const RRULE = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+:-]+)*$/
const POSITION = /^[0-9A-Za-z]{1,200}$/
const COLORS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'pink', 'teal', 'gray'])
const MAX_TITLE = 2000
const MAX_TAGS = 50

function checkPosition(v: unknown): string | null {
  return v === undefined || (typeof v === 'string' && POSITION.test(v))
    ? null
    : 'position is not a fractional index'
}

export const taskEntity: EntityTable = {
  kind: TASK_KIND,
  table: 'tasks.tasks',
  // Hub search (⌘K, `in:tasks`) indexes the title and notes on every write.
  search: { title: 'title', body: ['notes'] },
  fields: {
    listId: { column: 'list_id', type: 'uuid', nullable: true },
    parentId: { column: 'parent_id', type: 'uuid', nullable: true },
    title: { column: 'title', type: 'text', required: true },
    notes: { column: 'notes', type: 'text' },
    dueDate: { column: 'due_date', type: 'date', nullable: true },
    dueTime: { column: 'due_time', type: 'text', nullable: true },
    alertAt: { column: 'alert_at', type: 'timestamptz', nullable: true },
    rrule: { column: 'rrule', type: 'text', nullable: true },
    priority: { column: 'priority', type: 'int' },
    tags: { column: 'tags', type: 'jsonb' },
    position: { column: 'position', type: 'text' },
    completedAt: { column: 'completed_at', type: 'timestamptz', nullable: true },
    createdAt: { column: 'created_at', type: 'timestamptz' },
  },
  validate(f) {
    if (typeof f.title === 'string' && f.title.length > MAX_TITLE) return 'title is too long'
    if (typeof f.dueTime === 'string' && !TIME.test(f.dueTime)) return 'dueTime must be HH:MM'
    if (typeof f.rrule === 'string' && !RRULE.test(f.rrule)) return 'rrule is not an RRULE'
    if (f.priority !== undefined && ![0, 1, 2, 3].includes(f.priority as number))
      return 'priority must be 0 to 3'
    if (
      f.tags !== undefined &&
      !(
        Array.isArray(f.tags) &&
        f.tags.length <= MAX_TAGS &&
        f.tags.every((t) => typeof t === 'string')
      )
    )
      return 'tags must be a list of strings'
    return checkPosition(f.position)
  },
}

export const listEntity: EntityTable = {
  kind: LIST_KIND,
  table: 'tasks.lists',
  fields: {
    name: { column: 'name', type: 'text', required: true },
    color: { column: 'color', type: 'text' },
    position: { column: 'position', type: 'text' },
    createdAt: { column: 'created_at', type: 'timestamptz' },
  },
  validate(f) {
    if (typeof f.name === 'string' && (!f.name.trim() || f.name.length > 200))
      return 'name must be 1 to 200 characters'
    if (f.color !== undefined && !COLORS.has(f.color as string)) return 'color is not a list color'
    return checkPosition(f.position)
  },
}

export const TASKS_ENTITIES: EntityTable[] = [taskEntity, listEntity]
