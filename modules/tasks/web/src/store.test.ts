import {
  clockAt,
  FIXTURE_LISTS,
  fixtureId,
  LIST_ENTITY,
  TASK_ENTITY,
  tasksFixture,
  type Task,
  type TaskEntityWrite,
} from '@zachhub/tasks-core'
import { describe, expect, it } from 'vitest'
import { formatDay, formatNext } from './format'
import { dueOptions, listOptions, remindOptions } from './pickers'
import { TasksStore, type TasksBackend } from './store'

const now = new Date(2026, 9, 15, 14, 0) // Thu
const clock = clockAt(now)

function fakeBackend(seed: {
  tasks?: Record<string, unknown>[]
  lists?: Record<string, unknown>[]
}) {
  const rows = new Map<string, Map<string, Record<string, unknown>>>([
    [TASK_ENTITY, new Map((seed.tasks ?? []).map((r) => [r.id as string, r]))],
    [LIST_ENTITY, new Map((seed.lists ?? []).map((r) => [r.id as string, r]))],
  ])
  const listeners = new Set<() => void>()
  const writes: TaskEntityWrite[][] = []
  const backend: TasksBackend = {
    read: async (kind) => [...rows.get(kind)!.values()].map((r) => ({ ...r, id: r.id as string })),
    write: async (ws) => {
      writes.push(ws)
      for (const w of ws) {
        const table = rows.get(w.entity)!
        if (w.kind === 'delete') table.delete(w.id)
        else table.set(w.id, { ...table.get(w.id), ...w.fields, id: w.id })
      }
      listeners.forEach((fn) => fn())
    },
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
  return { backend, rows, writes, changed: () => listeners.forEach((fn) => fn()) }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('TasksStore', () => {
  it('applies ops optimistically and undoes', () => {
    const store = new TasksStore(tasksFixture({ now, tasks: 5 }))
    const id = fixtureId(0)
    const before = store.getState().tasks.get(id)!
    expect(store.run({ kind: 'tasks.update', id, patch: { title: 'Renamed' } }, 'Renamed')).toBe(
      true,
    )
    expect(store.getState().tasks.get(id)!.title).toBe('Renamed')
    expect(store.getToast()).toMatchObject({ text: 'Renamed', undo: true })
    expect(store.undo()).toBe(true)
    expect(store.getState().tasks.get(id)!.title).toBe(before.title)
    expect(store.undo()).toBe(false)
  })

  it('ignores ops that change nothing', () => {
    const store = new TasksStore(tasksFixture({ now, tasks: 1 }))
    const v = store.getVersion()
    expect(store.run({ kind: 'tasks.delete', id: 'missing' })).toBe(false)
    expect(store.getVersion()).toBe(v)
  })

  it('loads from the replica and writes only changed fields', async () => {
    const fx = tasksFixture({ now, tasks: 3 })
    const task = (t: Task) => {
      const { id, ...fields } = t
      return { id, ...fields }
    }
    const { backend, writes } = fakeBackend({
      tasks: [...fx.tasks.values()].map(task),
      lists: [...fx.lists.values()].map((l) => ({ ...l })),
    })
    const store = new TasksStore(undefined, backend)
    expect(store.loaded).toBe(false)
    await settle()
    expect(store.loaded).toBe(true)
    expect(store.getState().tasks.size).toBe(fx.tasks.size)
    expect(store.getState().lists.size).toBe(3)

    const id = fixtureId(0)
    store.run({ kind: 'tasks.update', id, patch: { title: 'Renamed' } })
    expect(writes).toEqual([
      [{ kind: 'put', entity: TASK_ENTITY, id, fields: { title: 'Renamed' } }],
    ])
    const renamed = store.getState().tasks.get(id)!
    await settle()
    // The re-read after our own write keeps object identity: rows don't re-render.
    expect(store.getState().tasks.get(id)).toBe(renamed)

    store.run({ kind: 'tasks.delete', id })
    // Deleting a parent deletes its subtasks with it.
    expect(writes.at(-1)![0]).toEqual({ kind: 'delete', entity: TASK_ENTITY, id })
    store.undo()
    await settle()
    expect(store.getState().tasks.get(id)!.title).toBe('Renamed')
  })

  it('picks up rows another device synced', async () => {
    const { backend, rows, changed } = fakeBackend({})
    const store = new TasksStore(undefined, backend)
    await settle()
    const id = fixtureId(42)
    rows.get(TASK_ENTITY)!.set(id, { id, title: 'From phone', position: 'a0', createdAt: 1 })
    changed()
    await settle()
    expect(store.getState().tasks.get(id)).toMatchObject({ title: 'From phone', listId: null })
  })

  it('drops a re-read raced by a newer local write', async () => {
    const { backend, changed } = fakeBackend({})
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow: TasksBackend = {
      ...backend,
      read: async (kind) => {
        await gate
        return backend.read(kind)
      },
    }
    const store = new TasksStore(undefined, slow)
    release()
    await settle()
    const task: Task = {
      ...tasksFixture({ now, tasks: 1 }).tasks.get(fixtureId(0))!,
      id: fixtureId(7),
    }
    changed()
    store.run({ kind: 'tasks.create', task })
    await settle()
    await settle()
    expect(store.getState().tasks.get(task.id)).toBeDefined()
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
        FIXTURE_LISTS.home,
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
