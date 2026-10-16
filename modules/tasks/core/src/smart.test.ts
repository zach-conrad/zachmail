import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { clockAt } from './dates'
import { tasksFixture } from './fixture'
import {
  countViews,
  selectTasks,
  TASKS_LOCAL_DDL,
  taskFromRow,
  taskToRow,
  viewSql,
  type TaskSqlRow,
  type TaskView,
} from './smart'

const now = new Date(2026, 9, 15, 14, 0)
const clock = clockAt(now)
const state = tasksFixture({ now, tasks: 400 })

const views: TaskView[] = [
  { kind: 'smart', key: 'today' },
  { kind: 'smart', key: 'upcoming' },
  { kind: 'smart', key: 'overdue' },
  { kind: 'smart', key: 'flagged' },
  { kind: 'inbox' },
  { kind: 'list', id: 'list-home' },
  { kind: 'list', id: 'list-work' },
]

describe('smart lists', () => {
  it('Today holds overdue first, then today; Upcoming is strictly later', () => {
    const today = selectTasks(state, { kind: 'smart', key: 'today' }, clock)
    expect(today.length).toBeGreaterThan(0)
    expect(today.every((t) => t.dueDate! <= clock.today && t.completedAt === null)).toBe(true)
    const dates = today.map((t) => t.dueDate!)
    expect([...dates].sort()).toEqual(dates)
    const upcoming = selectTasks(state, { kind: 'smart', key: 'upcoming' }, clock)
    expect(upcoming.every((t) => t.dueDate! > clock.today)).toBe(true)
  })

  it('counts every view in one pass, matching the selections', () => {
    const c = countViews(state, clock)
    expect(c.today).toBe(selectTasks(state, views[0]!, clock).length)
    expect(c.upcoming).toBe(selectTasks(state, views[1]!, clock).length)
    expect(c.overdue).toBe(selectTasks(state, views[2]!, clock).length)
    expect(c.flagged).toBe(selectTasks(state, views[3]!, clock).length)
    expect(c.inbox).toBe(selectTasks(state, views[4]!, clock).length)
    expect(c.lists.get('list-home')).toBe(selectTasks(state, views[5]!, clock).length)
  })

  it('SQL over the replica returns the same rows in the same order', () => {
    const db = new DatabaseSync(':memory:')
    for (const ddl of TASKS_LOCAL_DDL) db.exec(ddl)
    const insert = db.prepare(
      `INSERT INTO tasks_task VALUES (:id, :list_id, :parent_id, :title, :notes, :due_date, :due_time,
        :alert_at, :rrule, :priority, :tags, :position, :completed_at, :created_at, :updated_at)`,
    )
    for (const t of state.tasks.values()) insert.run({ ...taskToRow(t) })
    for (const view of views) {
      const { sql, params } = viewSql(view, clock)
      const rows = db.prepare(sql).all(...params) as unknown as TaskSqlRow[]
      expect(rows.map(taskFromRow), JSON.stringify(view)).toEqual(selectTasks(state, view, clock))
    }
  })

  it('selects a 5k-task view well inside a frame', () => {
    const big = tasksFixture({ now, tasks: 5000 })
    selectTasks(big, views[0]!, clock)
    const t0 = performance.now()
    for (const v of views) selectTasks(big, v, clock)
    countViews(big, clock)
    expect((performance.now() - t0) / (views.length + 1)).toBeLessThan(8)
  })
})
