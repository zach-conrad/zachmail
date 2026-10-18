import { formatHlc, type EntityOp } from '@zachhub/core'
import type { ProviderMessage } from '@zachhub/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EntityRegistry,
  HUB_ENTITIES,
  applyEntityOps,
  applySyncBatch,
  checkEntityTable,
  searchHub,
  type Db,
  type EntityTable,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

// A stand-in module table: no first-party module declares `search` yet.
const NOTES: EntityTable = {
  kind: 'notes.note',
  table: 'notes.notes',
  fields: {
    title: { column: 'title', type: 'text' },
    body: { column: 'body', type: 'text', nullable: true },
    tags: { column: 'tags', type: 'text', nullable: true },
    pinned: { column: 'pinned', type: 'bool' },
  },
  search: { title: 'title', body: ['body', 'tags'] },
}

let t: TestDb
let db: Db
const registry = new EntityRegistry([...HUB_ENTITIES, NOTES])
const OTHER = '00000000-0000-0000-0000-000000000002'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = (ms: number) => formatHlc(ms, 0, 'a')

const apply = (ops: EntityOp[], user = USER) =>
  db.transaction((tx) => applyEntityOps(tx, user, registry, ops))
const put = (n: number, fields: Record<string, unknown>, ms = 10, user = USER) =>
  apply([{ kind: 'put', entity: 'notes.note', id: id(n), hlc: at(ms), fields }], user)
const search = async (q: string, user = USER) =>
  (await searchHub(db, user, q, { registry, tzOffset: 0 })).hits.map((h) => `${h.kind} ${h.title}`)

const msg = (id: string, over: Partial<ProviderMessage>): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: id,
  rfc822MessageId: null,
  inReplyTo: null,
  references: [],
  from: { name: 'Ana Ruiz', email: 'ana@acme.com' },
  to: [{ email: 'zach@work.dev' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 'Hello',
  snippet: '',
  date: new Date('2026-10-01T12:00:00Z'),
  folderIds: ['INBOX'],
  unread: false,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  size: 1,
  attachments: [],
  ...over,
})

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  await t.exec(`
    INSERT INTO auth.users VALUES ('${OTHER}', 'other@example.com');
    CREATE SCHEMA notes;
    CREATE TABLE notes.notes (
      id uuid PRIMARY KEY, user_id uuid NOT NULL, field_hlc jsonb NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now(), title text NOT NULL DEFAULT '',
      body text, tags text, pinned boolean NOT NULL DEFAULT false
    );
  `)
  const [acct] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@work.dev')
     RETURNING id`,
    [USER],
  )
  await applySyncBatch(db, {
    userId: USER,
    accountId: acct!.id,
    batch: {
      folders: [
        { providerId: 'INBOX', name: 'INBOX', kind: 'inbox', unreadCount: 0, totalCount: 0 },
      ],
      deletedMessageIds: [],
      messages: [
        msg('m1', { subject: 'Q4 budget review', snippet: 'Numbers attached' }),
        msg('m2', { subject: 'Lunch?', snippet: 'About the budget too', folderIds: [] }),
      ],
    },
  })
})
afterAll(() => t.close())

describe('search index', () => {
  it('indexes declared fields on create and update, and drops the entry on delete', async () => {
    await put(1, { title: 'Budget plan', body: 'Draft for Q4', tags: 'finance' })
    const entry = () =>
      db.query<{ title: string; body: string }>(
        `SELECT title, body FROM hub.search_index WHERE entity_kind = 'notes.note' AND entity_id = $1`,
        [id(1)],
      )
    expect(await entry()).toEqual([{ title: 'Budget plan', body: 'Draft for Q4 finance' }])
    await put(1, { tags: null }, 20)
    expect(await entry()).toEqual([{ title: 'Budget plan', body: 'Draft for Q4' }])
    await apply([{ kind: 'delete', entity: 'notes.note', id: id(1), hlc: at(30) }])
    expect(await entry()).toEqual([])
  })

  it('leaves kinds without `search` out, and refuses non-text search fields', async () => {
    await apply([
      {
        kind: 'put',
        entity: 'hub.link',
        id: id(9),
        hlc: at(10),
        fields: { fromKind: 'a.b', fromId: '1', toKind: 'c.d', toId: '2', title: 'budget' },
      },
    ])
    expect(await db.query(`SELECT 1 FROM hub.search_index WHERE entity_id = $1`, [id(9)])).toEqual(
      [],
    )
    expect(() => checkEntityTable({ ...NOTES, search: { title: 'pinned' } })).toThrow(
      /Bad search field notes.note.pinned/,
    )
  })
})

describe('searchHub', () => {
  beforeAll(async () => {
    await put(2, { title: 'Budget for the offsite', body: 'Venue and travel' })
    await put(3, { title: 'Reading list', body: 'A note mentioning budget in passing' })
    await put(4, { title: 'Budget', body: 'Not mine' }, 10, OTHER)
  })

  it('unions module rows with mail threads, best first', async () => {
    expect(await search('budget')).toEqual([
      // Title (weight A) outranks body (D), in either source; trash-free inbox mail only.
      'notes.note Budget for the offsite',
      'mail.thread Q4 budget review',
      'notes.note Reading list',
      'mail.thread Lunch?',
    ])
    const r = await searchHub(db, USER, 'budg', { registry })
    expect(r.highlight).toEqual(['budg'])
    expect(r.hits[0]).toEqual({
      kind: 'notes.note',
      id: id(2),
      title: 'Budget for the offsite',
      snippet: 'Venue and travel',
      updatedAt: expect.any(Number),
      rank: expect.any(Number),
    })
  })

  it('scopes to modules with in:', async () => {
    expect(await search('in:notes budget')).toEqual([
      'notes.note Budget for the offsite',
      'notes.note Reading list',
    ])
    expect(await search('-in:notes budget')).toEqual([
      'mail.thread Q4 budget review',
      'mail.thread Lunch?',
    ])
    expect(await search('in:mail in:notes offsite')).toEqual(['notes.note Budget for the offsite'])
    // Mail-only operators can't match a note.
    expect(await search('in:inbox budget')).toEqual(['mail.thread Q4 budget review'])
    expect(await search('from:ana budget')).toEqual([
      'mail.thread Q4 budget review',
      'mail.thread Lunch?',
    ])
    expect(await search('subject:budget in:notes')).toEqual(['notes.note Budget for the offsite'])
  })

  it('catches typos in titles and honours negation and dates', async () => {
    expect(await search('in:notes offsit')).toEqual(['notes.note Budget for the offsite'])
    expect(await search('in:notes budgt ofsite')).toEqual(['notes.note Budget for the offsite'])
    expect(await search('budget -offsite in:notes')).toEqual(['notes.note Reading list'])
    expect(await search('in:notes budget before:2000/01/01')).toEqual([])
  })

  it("lists a module's newest rows for a bare in:, and never another user's", async () => {
    expect(await search('in:notes')).toEqual([
      'notes.note Reading list',
      'notes.note Budget for the offsite',
    ])
    expect(await search('budget', OTHER)).toEqual(['notes.note Budget'])
    expect(await search('')).toEqual([])
  })
})
