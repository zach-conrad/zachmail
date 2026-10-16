import { describe, expect, it } from 'vitest'
import {
  applyTaskOp,
  completeOp,
  emptyTasksState,
  invertTaskOp,
  stateReader,
  type TaskOp,
  type TasksState,
} from './ops'
import type { Task, TaskList } from './types'

const AT = 1_000
const task = (over: Partial<Task> = {}): Task => ({
  id: 't1',
  listId: null,
  parentId: null,
  title: 'Pay rent',
  notes: '',
  dueDate: null,
  dueTime: null,
  alertAt: null,
  rrule: null,
  priority: 0,
  tags: [],
  position: 'a0',
  completedAt: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})
const list = (over: Partial<TaskList> = {}): TaskList => ({
  id: 'l1',
  name: 'Home',
  color: 'green',
  position: 'a0',
  createdAt: 0,
  updatedAt: 0,
  ...over,
})
const stateOf = (tasks: Task[], lists: TaskList[] = []): TasksState => ({
  tasks: new Map(tasks.map((t) => [t.id, t])),
  lists: new Map(lists.map((l) => [l.id, l])),
})

/** Applies op, then its inverse, and expects the original state back (ignoring updatedAt). */
function roundTrip(state: TasksState, op: TaskOp) {
  const inverse = invertTaskOp(op, stateReader(state))
  expect(inverse).not.toBeNull()
  const after = applyTaskOp(state, op, AT)
  const back = applyTaskOp(after, inverse!, AT)
  const strip = (s: TasksState) => ({
    tasks: [...s.tasks.values()]
      .map((t) => ({ ...t, updatedAt: 0 }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    lists: [...s.lists.values()]
      .map((l) => ({ ...l, updatedAt: 0 }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  })
  expect(strip(back)).toEqual(strip(state))
  return after
}

describe('task ops', () => {
  it('creates, updates and deletes with exact undo', () => {
    const s0 = emptyTasksState()
    const s1 = roundTrip(s0, { kind: 'tasks.create', task: task() })
    expect(s1.tasks.get('t1')?.title).toBe('Pay rent')
    const s2 = roundTrip(s1, {
      kind: 'tasks.update',
      id: 't1',
      patch: { title: 'Pay rent!', dueDate: '2026-11-01' },
    })
    expect(s2.tasks.get('t1')).toMatchObject({
      title: 'Pay rent!',
      dueDate: '2026-11-01',
      updatedAt: AT,
    })
    roundTrip(s1, { kind: 'tasks.delete', id: 't1' })
  })

  it('clears the time when the date is cleared, and undo restores both', () => {
    const s = stateOf([task({ dueDate: '2026-11-01', dueTime: '09:00' })])
    const after = roundTrip(s, { kind: 'tasks.update', id: 't1', patch: { dueDate: null } })
    expect(after.tasks.get('t1')?.dueTime).toBeNull()
  })

  it('deletes subtasks with their parent and restores them', () => {
    const s = stateOf([task(), task({ id: 't2', parentId: 't1' }), task({ id: 't3' })])
    const after = roundTrip(s, { kind: 'tasks.delete', id: 't1' })
    expect([...after.tasks.keys()]).toEqual(['t3'])
  })

  it('completes a plain task', () => {
    const s = stateOf([task()])
    const { op, nextDue } = completeOp(s.tasks.get('t1')!, new Date(2026, 9, 15, 14), () => 'new')
    expect(nextDue).toBeNull()
    const after = roundTrip(s, op)
    expect(after.tasks.get('t1')?.completedAt).toBe(new Date(2026, 9, 15, 14).getTime())
    // Completing twice changes nothing.
    expect(applyTaskOp(after, op, AT)).toBe(after)
  })

  it('completing a recurring task creates the next instance in the same op', () => {
    const alertAt = new Date(2026, 10, 1, 9, 0).getTime()
    const s = stateOf([
      task({
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
        dueDate: '2026-11-01',
        dueTime: '09:00',
        alertAt,
        listId: 'l1',
      }),
    ])
    const { op, nextDue } = completeOp(
      s.tasks.get('t1')!,
      new Date(2026, 9, 30, 8),
      () => 't1-next',
    )
    expect(nextDue).toBe('2026-12-01')
    const after = roundTrip(s, op)
    expect(after.tasks.get('t1')).toMatchObject({ rrule: null })
    expect(after.tasks.get('t1')?.completedAt).not.toBeNull()
    expect(after.tasks.get('t1-next')).toMatchObject({
      dueDate: '2026-12-01',
      dueTime: '09:00',
      alertAt: new Date(2026, 11, 1, 9, 0).getTime(),
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      listId: 'l1',
      completedAt: null,
    })
  })

  it('ends a finished series without a next instance', () => {
    const s = stateOf([task({ rrule: 'FREQ=DAILY;COUNT=1', dueDate: '2026-10-15' })])
    const { op } = completeOp(s.tasks.get('t1')!, new Date(2026, 9, 15, 14), () => 'n')
    const after = applyTaskOp(s, op, AT)
    expect(after.tasks.size).toBe(1)
    expect(after.tasks.get('t1')?.rrule).toBe('FREQ=DAILY;COUNT=1')
  })

  it('deleting a list moves its tasks to the Inbox, and undo moves them back', () => {
    const s = stateOf(
      [task({ listId: 'l1' }), task({ id: 't2', listId: 'l2' })],
      [list(), list({ id: 'l2' })],
    )
    const after = roundTrip(s, { kind: 'tasks.list.delete', id: 'l1' })
    expect(after.lists.has('l1')).toBe(false)
    expect(after.tasks.get('t1')?.listId).toBeNull()
    expect(after.tasks.get('t2')?.listId).toBe('l2')
    roundTrip(s, { kind: 'tasks.list.update', id: 'l1', patch: { name: 'House', color: 'blue' } })
    roundTrip(emptyTasksState(), { kind: 'tasks.list.create', list: list() })
  })

  it('ignores ops on rows that no longer exist', () => {
    const s = stateOf([])
    for (const op of [
      { kind: 'tasks.update', id: 'x', patch: { title: 'y' } },
      { kind: 'tasks.complete', id: 'x', at: 1 },
      { kind: 'tasks.delete', id: 'x' },
      { kind: 'tasks.list.update', id: 'x', patch: { name: 'y' } },
    ] as TaskOp[]) {
      expect(applyTaskOp(s, op, AT)).toBe(s)
      expect(invertTaskOp(op, stateReader(s))).toBeNull()
    }
  })
})
