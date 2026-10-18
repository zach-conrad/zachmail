/** Deterministic tasks fixture for tests, perf checks and the web demo. */
import { addDays, dateKey } from './dates'
import { positionBetween } from './order'
import type { TasksState } from './ops'
import type { Priority, Task, TaskList } from './types'

export interface FixtureOptions {
  now: Date
  tasks?: number
  seed?: number
}

const TITLES = [
  'Pay rent',
  'Call mom',
  'Renew passport',
  'Book dentist',
  'Review Q4 plan',
  'Water plants',
  'Send invoice',
  'Buy groceries',
  'Fix the leaky tap',
  'Reply to Sam about the lease',
  'Back up laptop',
  'Plan weekend trip',
  'Cancel trial subscription',
  'Prep slides for Monday',
  'Order printer ink',
]

/** Deterministic UUIDs, so fixture rows pass the entity id check. */
export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const FIXTURE_LISTS = {
  home: fixtureId(900_000),
  work: fixtureId(900_001),
  errands: fixtureId(900_002),
}

/** A small PRNG so fixtures are stable across runs. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function tasksFixture({ now, tasks: count = 40, seed = 7 }: FixtureOptions): TasksState {
  const rand = mulberry32(seed)
  const at = now.getTime()
  const today = dateKey(now)
  const lists: TaskList[] = [
    ['home', 'Home', 'green'],
    ['work', 'Work', 'blue'],
    ['errands', 'Errands', 'orange'],
  ].map(([, name, color], i) => ({
    id: fixtureId(900_000 + i),
    name: name!,
    color: color!,
    position: `a${i}`,
    createdAt: at,
  }))
  const out = new Map<string, Task>()
  let position: string | null = null
  for (let i = 0; i < count; i++) {
    const r = rand()
    const dueDate =
      r < 0.15
        ? addDays(today, -1 - Math.floor(rand() * 5))
        : r < 0.4
          ? today
          : r < 0.7
            ? addDays(today, 1 + Math.floor(rand() * 14))
            : null
    const timed = dueDate !== null && rand() < 0.4
    const dueTime = timed
      ? `${String(8 + Math.floor(rand() * 11)).padStart(2, '0')}:${rand() < 0.5 ? '00' : '30'}`
      : null
    const listPick = rand()
    const recurring = rand() < 0.12
    position = positionBetween(position, null)
    const t: Task = {
      id: fixtureId(i),
      listId: listPick < 0.25 ? null : lists[Math.floor(rand() * lists.length)]!.id,
      parentId: null,
      title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` ${Math.floor(i / TITLES.length) + 1}` : ''}`,
      notes: '',
      dueDate,
      dueTime,
      alertAt: null,
      rrule: recurring ? (rand() < 0.5 ? 'FREQ=WEEKLY' : 'FREQ=MONTHLY;BYMONTHDAY=1') : null,
      priority: (rand() < 0.15 ? 3 : rand() < 0.2 ? 2 : 0) as Priority,
      tags: [],
      position,
      completedAt: rand() < 0.1 ? at - 3_600_000 : null,
      createdAt: at - i * 60_000,
    }
    if (dueDate && dueTime) {
      const [y, m, d] = dueDate.split('-').map(Number) as [number, number, number]
      const [hh, mm] = dueTime.split(':').map(Number) as [number, number]
      t.alertAt = new Date(y, m - 1, d, hh, mm).getTime()
    }
    out.set(t.id, t)
  }
  // A couple of subtasks under the first open task with a list.
  const parent = [...out.values()].find((t) => t.listId && t.completedAt === null)
  if (parent)
    for (let i = 0; i < 2; i++) {
      const id = fixtureId(800_000 + i)
      out.set(id, {
        ...parent,
        id,
        parentId: parent.id,
        title: i === 0 ? 'Check the details' : 'Confirm by email',
        dueDate: null,
        dueTime: null,
        alertAt: null,
        rrule: null,
        priority: 0,
        position: `a${i}`,
      })
    }
  return { tasks: out, lists: new Map(lists.map((l) => [l.id, l])) }
}
