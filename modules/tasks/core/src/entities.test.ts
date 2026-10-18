import { describe, expect, it } from 'vitest'
import { effectToWrites, listFromEntity, taskFromEntity, TASK_ENTITY } from './entities'
import { fixtureId, tasksFixture } from './fixture'
import { completeOp, stateReader, taskOpEffect } from './ops'

const now = new Date(2026, 9, 15, 14, 0)

describe('tasks as entities', () => {
  it('writes only the fields an op changed', () => {
    const state = tasksFixture({ now, tasks: 3 })
    const read = stateReader(state)
    const op = {
      kind: 'tasks.update' as const,
      id: fixtureId(0),
      patch: { title: 'New', notes: '' },
    }
    expect(effectToWrites(taskOpEffect(op, read), read)).toEqual([
      { kind: 'put', entity: TASK_ENTITY, id: fixtureId(0), fields: { title: 'New' } },
    ])
  })

  it('creates with every field and deletes subtasks with their parent', () => {
    const state = tasksFixture({ now, tasks: 40 })
    const read = stateReader(state)
    const recurring = [...state.tasks.values()].find((t) => t.rrule && !t.completedAt)!
    const { op } = completeOp(recurring, now, () => fixtureId(5000))
    const writes = effectToWrites(taskOpEffect(op, read), read)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({
      id: recurring.id,
      fields: { completedAt: now.getTime(), rrule: null },
    })
    expect(Object.keys((writes[1] as { fields: object }).fields)).toHaveLength(13)

    const parent = [...state.tasks.values()].find((t) =>
      [...state.tasks.values()].some((c) => c.parentId === t.id),
    )!
    const del = effectToWrites(taskOpEffect({ kind: 'tasks.delete', id: parent.id }, read), read)
    expect(del.map((w) => w.kind)).toEqual(['delete', 'delete', 'delete'])
  })

  it('reads partial rows safely and round-trips full ones', () => {
    const t = tasksFixture({ now, tasks: 1 }).tasks.get(fixtureId(0))!
    const { id, ...fields } = t
    expect(taskFromEntity({ id, ...fields })).toEqual(t)
    expect(taskFromEntity({ id, priority: 3 })).toBeNull()
    expect(taskFromEntity({ id, title: 'x', priority: 9, tags: [1, 'a'] })).toMatchObject({
      priority: 0,
      tags: ['a'],
      listId: null,
    })
    expect(listFromEntity({ id, name: 'Home' })).toMatchObject({ color: 'gray', position: 'a0' })
  })
})
