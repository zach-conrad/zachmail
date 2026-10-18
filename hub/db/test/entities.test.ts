import { formatHlc, type EntityOp } from '@zachhub/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EntityRegistry,
  HUB_ENTITIES,
  applyEntityOps,
  readBootstrap,
  readDelta,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
const registry = new EntityRegistry(HUB_ENTITIES)
const OTHER = '00000000-0000-0000-0000-000000000002'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (ms: number, node = 'a') => formatHlc(ms, 0, node)
const link = { fromKind: 'tasks.task', fromId: 't1', toKind: 'mail.thread', toId: 'm1' }

const apply = (ops: EntityOp[], user = USER) =>
  db.transaction((tx) => applyEntityOps(tx, user, registry, ops))
const row = async (n: number) =>
  (
    await db.query<{ title: string; to_id: string }>(
      `SELECT title, to_id FROM hub.links WHERE id = $1`,
      [id(n)],
    )
  )[0]

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  await t.exec(`INSERT INTO auth.users VALUES ('${OTHER}', 'other@example.com')`)
})
afterAll(() => t.close())

describe('first-party entities', () => {
  it('creates a row and logs the change', async () => {
    const res = await apply([
      { kind: 'put', entity: 'hub.link', id: id(1), hlc: at(10), fields: { ...link, title: 'a' } },
    ])
    expect(res).toEqual({ accepted: [0], rejected: [] })
    expect(await row(1)).toEqual({ title: 'a', to_id: 'm1' })
    const delta = await readDelta(db, USER, 0, 5000, registry)
    expect(delta.entities?.['hub.link']).toEqual({
      upserts: [
        expect.objectContaining({ id: id(1), title: 'a', toId: 'm1', fromKind: 'tasks.task' }),
      ],
      deletes: [],
    })
    expect(typeof delta.entities!['hub.link']!.upserts[0]!.createdAt).toBe('number')
  })

  it('keeps the newest value per field, whatever order writes arrive in', async () => {
    await apply([
      { kind: 'put', entity: 'hub.link', id: id(1), hlc: at(30, 'b'), fields: { title: 'b' } },
      // Older stamp: loses on title, but toId has never been written after 10, so it wins.
      {
        kind: 'put',
        entity: 'hub.link',
        id: id(1),
        hlc: at(20),
        fields: { title: 'x', toId: 'm2' },
      },
    ])
    expect(await row(1)).toEqual({ title: 'b', to_id: 'm2' })
    // A replay of an accepted write changes nothing.
    const before = await readDelta(db, USER, 0, 5000, registry)
    await apply([
      { kind: 'put', entity: 'hub.link', id: id(1), hlc: at(30, 'b'), fields: { title: 'b' } },
    ])
    expect((await readDelta(db, USER, 0, 5000, registry)).seq).toBe(before.seq)
  })

  it('rejects bad writes without touching the row', async () => {
    const res = await apply([
      { kind: 'put', entity: 'hub.nope', id: id(2), hlc: at(40), fields: { title: 'x' } },
      {
        kind: 'put',
        entity: 'hub.link',
        id: id(2),
        hlc: at(40),
        fields: { title: 'missing from' },
      },
      { kind: 'put', entity: 'hub.link', id: id(1), hlc: at(40), fields: { title: 5 } },
      { kind: 'put', entity: 'hub.link', id: id(1), hlc: at(40), fields: { color: 'red' } },
    ])
    expect(res.accepted).toEqual([])
    expect(res.rejected.map((r) => r.error)).toEqual([
      'Unknown entity hub.nope',
      'fromKind is required',
      'title must be text',
      'Unknown field hub.link.color',
    ])
    expect(await row(1)).toEqual({ title: 'b', to_id: 'm2' })
  })

  it("never shows or changes another user's rows", async () => {
    const res = await apply(
      [{ kind: 'put', entity: 'hub.link', id: id(1), hlc: at(99), fields: { title: 'mine' } }],
      OTHER,
    )
    expect(res.rejected).toEqual([{ index: 0, error: 'Not found' }])
    expect((await readDelta(db, OTHER, 0, 5000, registry)).entities).toEqual({})
  })

  it('deletes for good: later puts for the id are ignored', async () => {
    await apply([{ kind: 'delete', entity: 'hub.link', id: id(1), hlc: at(50) }])
    await apply([
      {
        kind: 'put',
        entity: 'hub.link',
        id: id(1),
        hlc: at(60),
        fields: { ...link, title: 'back' },
      },
    ])
    expect(await row(1)).toBeUndefined()
    expect((await readDelta(db, USER, 0, 5000, registry)).entities?.['hub.link']).toEqual({
      upserts: [],
      deletes: [id(1)],
    })
  })

  it('bootstraps every row of every registered kind', async () => {
    await apply([
      { kind: 'put', entity: 'hub.link', id: id(3), hlc: at(70), fields: { ...link, title: 'c' } },
    ])
    const got: unknown[] = []
    await readBootstrap(db, USER, 30, () => {}, 1000, {
      registry,
      onRows: (kind, rows) => got.push([kind, rows.map((r) => r.id)]),
    })
    expect(got).toEqual([['hub.link', [id(3)]]])
  })
})
