import { clockAt, tasksFixture, type Task } from '@zachhub/tasks-core'
import { describe, expect, it } from 'vitest'
import { formatDay, formatNext } from './format'
import { dueOptions, listOptions, remindOptions } from './pickers'
import { TasksStore } from './store'

const now = new Date(2026, 9, 15, 14, 0) // Thu
const clock = clockAt(now)

describe('TasksStore', () => {
  it('applies ops optimistically, queues them, and undoes', () => {
    const store = new TasksStore(tasksFixture({ now, tasks: 5 }), false)
    const id = 'task-0'
    const before = store.getState().tasks.get(id)!
    expect(store.run({ kind: 'tasks.update', id, patch: { title: 'Renamed' } }, 'Renamed')).toBe(
      true,
    )
    expect(store.getState().tasks.get(id)!.title).toBe('Renamed')
    expect(store.getToast()).toMatchObject({ text: 'Renamed', undo: true })
    expect(store.pending).toHaveLength(1)
    expect(store.undo()).toBe(true)
    expect(store.getState().tasks.get(id)!.title).toBe(before.title)
    expect(store.pending).toHaveLength(2)
    expect(store.undo()).toBe(false)
  })

  it('ignores ops that change nothing', () => {
    const store = new TasksStore(tasksFixture({ now, tasks: 1 }), false)
    const v = store.getVersion()
    expect(store.run({ kind: 'tasks.delete', id: 'missing' })).toBe(false)
    expect(store.getVersion()).toBe(v)
    expect(store.pending).toHaveLength(0)
  })
})

describe('pickers', () => {
  it('D offers presets and parses typed dates and repeats', () => {
    const patches: unknown[] = []
    const opts = dueOptions('every monday 9am', clock, now, (p) => patches.push(p))
    expect(opts[0]).toMatchObject({ id: 'parsed', hint: 'Weekly on Mon' })
    opts[0]!.run()
    expect(patches[0]).toMatchObject({
      dueDate: '2026-10-19',
      dueTime: '09:00',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    })
    expect(dueOptions('', clock, now, () => {}).map((o) => o.id)).toEqual([
      'today',
      'tomorrow',
      'weekend',
      'nextweek',
      'none',
    ])
  })

  it('H dates an undated task and hides presets already past', () => {
    const patches: Partial<Task>[] = []
    const late = new Date(2026, 9, 15, 19, 0)
    const opts = remindOptions('', clockAt(late), late, false, (p) => patches.push(p))
    expect(opts.map((o) => o.id)).not.toContain('evening')
    opts.find((o) => o.id === 'tomorrow')!.run()
    expect(patches[0]).toEqual({
      alertAt: new Date(2026, 9, 16, 9, 0).getTime(),
      dueDate: '2026-10-16',
    })
  })

  it('L filters lists and offers to create a new one', () => {
    const { lists } = tasksFixture({ now, tasks: 1 })
    const all = [...lists.values()]
    expect(
      listOptions(
        'wo',
        all,
        null,
        () => {},
        () => {},
      ).map((o) => o.label),
    ).toEqual(['Work', 'New list “wo”'])
    expect(
      listOptions(
        '',
        all,
        'list-home',
        () => {},
        () => {},
      ).map((o) => o.label),
    ).toEqual(['Inbox', 'Work', 'Errands'])
  })
})

describe('format', () => {
  it('names nearby days', () => {
    expect(formatDay('2026-10-15', clock)).toBe('Today')
    expect(formatDay('2026-10-16', clock)).toBe('Tomorrow')
    expect(formatDay('2026-10-14', clock)).toBe('Yesterday')
    expect(formatNext('2026-10-16', clock)).toBe('next due tomorrow')
  })
})
