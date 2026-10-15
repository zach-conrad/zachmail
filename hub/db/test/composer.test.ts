import type { SnippetInput } from '@zachhub/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SnippetConflictError,
  applySyncBatch,
  deleteSnippet,
  dismissNudges,
  readBootstrap,
  readDelta,
  readSnippets,
  restoreNudges,
  upsertSnippet,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let threadId: string

const OTHER = '00000000-0000-0000-0000-000000000002'
const S1 = '00000000-0000-4000-8000-00000000a001'
const S2 = '00000000-0000-4000-8000-00000000a002'

const snippet = (over: Partial<SnippetInput> = {}): SnippetInput => ({
  name: 'Intro call',
  shortcut: 'call',
  subject: 'Quick call?',
  html: '<p>Hi {first_name|there}</p>',
  cc: [],
  bcc: [{ email: 'crm@x.com' }],
  ...over,
})

const seqNow = async () =>
  (await db.query<{ s: number }>(`SELECT COALESCE(max(seq), 0)::float8 AS s FROM changes`))[0]!.s

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  await t.exec(`INSERT INTO auth.users VALUES ('${OTHER}', 'other@example.com')`)
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@x.com') RETURNING id`,
    [USER],
  )
  await applySyncBatch(db, {
    userId: USER,
    accountId: a!.id,
    batch: {
      deletedMessageIds: [],
      messages: [
        {
          providerMessageId: 'p1',
          providerThreadId: 'pt1',
          rfc822MessageId: '<p1@x>',
          inReplyTo: null,
          references: [],
          from: { email: 'zach@x.com' },
          to: [{ email: 'ana@x.com' }],
          cc: [],
          bcc: [],
          replyTo: [],
          subject: 'Proposal',
          snippet: 'Any thoughts on the proposal?',
          date: new Date('2026-10-01T10:00:00Z'),
          folderIds: [],
          unread: false,
          starred: false,
          hasAttachments: false,
          listUnsubscribe: null,
          size: 10,
          attachments: [],
        },
      ],
    },
  })
  threadId = (await db.query<{ id: string }>(`SELECT id FROM threads`))[0]!.id
})
afterAll(() => t.close())

describe('snippets', () => {
  it('upserts, syncs and deletes', async () => {
    const since = await seqNow()
    expect(await upsertSnippet(db, USER, S1, snippet())).toBe(true)
    expect(await upsertSnippet(db, USER, S1, snippet({ name: 'Call' }))).toBe(true)
    const [row] = await readSnippets(db, USER)
    expect(row).toMatchObject({
      id: S1,
      name: 'Call',
      shortcut: 'call',
      bcc: [{ email: 'crm@x.com' }],
    })
    expect(typeof row!.updatedAt).toBe('number')

    const delta = await readDelta(db, USER, since)
    expect(delta.upserts.snippets.map((s) => s.name)).toEqual(['Call'])

    const before = await seqNow()
    await deleteSnippet(db, USER, S1)
    await deleteSnippet(db, USER, S1)
    const gone = await readDelta(db, USER, before)
    expect(gone.deletes.snippet).toEqual([S1])
    expect(await readSnippets(db, USER)).toEqual([])
  })

  it('keeps shortcuts unique and ids owned', async () => {
    await upsertSnippet(db, USER, S1, snippet())
    await expect(upsertSnippet(db, USER, S2, snippet({ name: 'Other' }))).rejects.toThrow(
      SnippetConflictError,
    )
    // Picker-only snippets may share the empty shortcut.
    expect(await upsertSnippet(db, USER, S2, snippet({ shortcut: '' }))).toBe(true)
    await upsertSnippet(db, OTHER, '00000000-0000-4000-8000-00000000b001', snippet())
    expect(await upsertSnippet(db, OTHER, S1, snippet({ shortcut: 'x' }))).toBe(false)
    expect((await readSnippets(db, USER)).find((s) => s.id === S1)!.shortcut).toBe('call')
  })

  it('ships in the bootstrap', async () => {
    const chunks: { snippets?: unknown[] }[] = []
    await readBootstrap(db, USER, 365, (r) => chunks.push(r))
    expect(chunks[0]!.snippets).toHaveLength(2)
  })
})

describe('nudge dismissals', () => {
  it('records the thread position, syncs, and restores', async () => {
    const since = await seqNow()
    const rows = await dismissNudges(db, USER, [threadId, '00000000-0000-4000-8000-00000000ffff'])
    expect(rows).toEqual([{ id: threadId, lastMessageAt: Date.parse('2026-10-01T10:00:00Z') }])
    expect(await dismissNudges(db, OTHER, [threadId])).toEqual([])

    const delta = await readDelta(db, USER, since)
    expect(delta.upserts.nudgeDismissals).toEqual(rows)

    const chunks: { nudgeDismissals?: unknown[] }[] = []
    await readBootstrap(db, USER, 365, (r) => chunks.push(r))
    expect(chunks[0]!.nudgeDismissals).toEqual(rows)

    const before = await seqNow()
    await restoreNudges(db, USER, [threadId])
    expect((await readDelta(db, USER, before)).deletes.nudgeDismissal).toEqual([threadId])
  })
})
