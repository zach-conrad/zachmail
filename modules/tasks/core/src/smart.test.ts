import { describe, expect, it } from 'vitest'
import { clockAt } from './dates'
import { FIXTURE_LISTS, tasksFixture } from './fixture'
import { countViews, selectTasks, type TaskView } from './smart'

const now = new Date(2026, 9, 15, 14, 0)
const clock = clockAt(now)
const state = tasksFixture({ now, tasks: 400 })

const views: TaskView[] = [
  { kind: 'smart', key: 'today' },
  { kind: 'smart', key: 'upcoming' },
  { kind: 'smart', key: 'overdue' },
  { kind: 'smart', key: 'flagged' },
  { kind: 'inbox' },
  { kind: 'list', id: FIXTURE_LISTS.home },
  { kind: 'list', id: FIXTURE_LISTS.work },
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
    expect(c.lists.get(FIXTURE_LISTS.home)).toBe(selectTasks(state, views[5]!, clock).length)
  })

  it('selects a 5k-task view well inside a frame', () => {
    const big = tasksFixture({ now, tasks: 5000 })
    // Best of five: the test runs beside other suites, and only the code's cost is being held.
    let best = Infinity
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now()
      for (const v of views) selectTasks(big, v, clock)
      countViews(big, clock)
      best = Math.min(best, (performance.now() - t0) / (views.length + 1))
    }
    expect(best).toBeLessThan(8)
  })
})
