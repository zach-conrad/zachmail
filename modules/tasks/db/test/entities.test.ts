import { formatHlc, type EntityOp } from '@zachhub/core'
import {
  EntityRegistry,
  HUB_ENTITIES,
  applyEntityOps,
  readDelta,
  type Db,
} from '@zachhub/db/server'
import { USER, createTestDb, type TestDb } from '@zachhub/db/testing'
import {
  LIST_FIELDS,
  TASK_FIELDS,
  effectToWrites,
  emptyTasksState,
  stateReader,
  taskFromEntity,
  taskOpEffect,
  type Task,
} from '@zachhub/tasks-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LIST_KIND, TASKS_ENTITIES, TASK_KIND, listEntity, taskEntity } from '../src'

let t: TestDb
let db: Db
const registry = new EntityRegistry([...HUB_ENTITIES, ...TASKS_ENTITIES])
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let ms = 1000
const stamp = () => formatHlc(ms++, 0, 'web')

const apply = (ops: EntityOp[]) => db.transaction((tx) => applyEntityOps(tx, USER, registry, ops))

const task: Task = {
  id: id(1),
  listId: id(100),
  parentId: null,
  title: 'Pay rent',
  notes: '',
  dueDate: '2026-11-01',
  dueTime: '09:00',
  alertAt: Date.UTC(2026, 10, 1, 14),
  rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
  priority: 3,
  tags: ['home'],
  position: 'a0',
  completedAt: null,
  createdAt: Date.UTC(2026, 9, 16),
}

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
})
afterAll(() => t.close())

describe('tasks entities', () => {
  it('declares exactly the fields tasks-core writes', () => {
    expect(Object.keys(taskEntity.fields).sort()).toEqual([...TASK_FIELDS].sort())
    expect(Object.keys(listEntity.fields).sort()).toEqual([...LIST_FIELDS].sort())
  })

  it('round-trips a task written by the client through the server delta', async () => {
    const effect = taskOpEffect({ kind: 'tasks.create', task }, stateReader(emptyTasksState()))
    const writes = effectToWrites(effect, stateReader(emptyTasksState()))
    const ops = writes.map((w) => ({ ...w, hlc: stamp() }) as EntityOp)
    const list: EntityOp = {
      kind: 'put',
      entity: LIST_KIND,
      id: id(100),
      hlc: stamp(),
      fields: { name: 'Home', color: 'green', position: 'a0', createdAt: task.createdAt },
    }
    expect(await apply([...ops, list])).toEqual({ accepted: [0, 1], rejected: [] })

    const delta = await readDelta(db, USER, 0, 5000, registry)
    const row = delta.entities?.[TASK_KIND]?.upserts[0]
    expect(row).toBeDefined()
    expect(taskFromEntity(row!)).toEqual(task)
    expect(delta.entities?.[LIST_KIND]?.upserts[0]).toMatchObject({ name: 'Home', color: 'green' })
  })

  it('merges per field: a stale title write keeps a newer completion', async () => {
    const done = Date.UTC(2026, 10, 1, 15)
    const newer = stamp()
    const older = formatHlc(1, 0, 'phone')
    await apply([
      { kind: 'put', entity: TASK_KIND, id: id(1), hlc: newer, fields: { completedAt: done } },
      { kind: 'put', entity: TASK_KIND, id: id(1), hlc: older, fields: { title: 'Rent' } },
    ])
    const rows = await db.query<{ title: string; completed: boolean }>(
      `SELECT title, completed_at IS NOT NULL AS completed FROM tasks.tasks WHERE id = $1`,
      [id(1)],
    )
    // The title was last written at ms 1000+, so the phone's stamp-1 write loses on title only.
    expect(rows[0]).toEqual({ title: 'Pay rent', completed: true })
  })

  it('refuses malformed fields', async () => {
    const bad = (fields: Record<string, unknown>) =>
      apply([{ kind: 'put', entity: TASK_KIND, id: id(2), hlc: stamp(), fields }])
    for (const fields of [
      { title: 'x', dueTime: '9am' },
      { title: 'x', rrule: 'every day' },
      { title: 'x', priority: 5 },
      { title: 'x', tags: [1] },
      { title: 'x', position: 'not a key!' },
    ]) {
      const res = await bad(fields)
      expect(res.accepted).toEqual([])
      expect(res.rejected).toHaveLength(1)
    }
    const listRes = await apply([
      {
        kind: 'put',
        entity: LIST_KIND,
        id: id(3),
        hlc: stamp(),
        fields: { name: 'x', color: 'mauve' },
      },
    ])
    expect(listRes.rejected).toHaveLength(1)
  })

  it('deletes and logs the delete', async () => {
    await apply([{ kind: 'delete', entity: TASK_KIND, id: id(1), hlc: stamp() }])
    const delta = await readDelta(db, USER, 0, 5000, registry)
    expect(delta.entities?.[TASK_KIND]?.deletes).toContain(id(1))
  })
})
