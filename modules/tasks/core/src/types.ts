/**
 * Tasks module domain types (ZACHHUB_PLAN.md §3.2). A reminder is a task with an alert; a todo
 * is a task in a list. Dates are floating local dates ("YYYY-MM-DD") and times ("HH:MM") so a
 * task due on the 1st stays due on the 1st whatever time zone the device is in. `alertAt` is an
 * absolute instant (epoch ms), like snooze times in mail.
 */

/** 0 none, 1 low, 2 medium, 3 high. High is what the Flagged smart list shows. */
export type Priority = 0 | 1 | 2 | 3

export interface Task {
  id: string
  /** null = Inbox (no list). */
  listId: string | null
  /** Subtasks point at their parent; only one level deep. */
  parentId: string | null
  title: string
  notes: string
  dueDate: string | null
  /** Only set together with dueDate. */
  dueTime: string | null
  alertAt: number | null
  /** RFC 5545 RRULE body without the "RRULE:" prefix, e.g. "FREQ=MONTHLY;BYMONTHDAY=1". */
  rrule: string | null
  priority: Priority
  tags: string[]
  /** Fractional index (`fractional-indexing`); compare with `<`, never localeCompare. */
  position: string
  completedAt: number | null
  createdAt: number
}

export interface TaskList {
  id: string
  name: string
  /** One of LIST_COLORS, drawn from the account palette in hub tokens. */
  color: string
  position: string
  createdAt: number
}

/** Fields an update op may change. */
export type TaskPatch = Partial<
  Pick<
    Task,
    | 'listId'
    | 'parentId'
    | 'title'
    | 'notes'
    | 'dueDate'
    | 'dueTime'
    | 'alertAt'
    | 'rrule'
    | 'priority'
    | 'tags'
    | 'position'
  >
>

export type TaskListPatch = Partial<Pick<TaskList, 'name' | 'color' | 'position'>>

/** List colors, in the order of the account palette in hub tokens (`tokens.account`). */
export const LIST_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'pink',
  'teal',
  'gray',
] as const
