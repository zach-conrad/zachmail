import type { Rows } from '@zachmail/core'
import type { ProviderMessage, SyncBatch } from '@zachmail/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySyncBatch,
  readBootstrap,
  readContacts,
  readDelta,
  updateAccount,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let accountId: string

const msg = (id: string, thread: string, over: Partial<ProviderMessage> = {}): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: thread,
  rfc822MessageId: `<${id}@x>`,
  inReplyTo: null,
  references: [],
  from: { name: 'Ana', email: 'ana@x.com' },
  to: [{ email: 'zach@x.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: `Subject ${thread}`,
  snippet: `snippet ${id}`,
  date: new Date('2026-10-12T10:00:00Z'),
  folderIds: ['INBOX'],
  unread: false,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  size: 100,
  attachments: [],
  ...over,
})

const batch = (b: Partial<SyncBatch>): SyncBatch => ({ messages: [], deletedMessageIds: [], ...b })
const FOLDERS = [
  { providerId: 'INBOX', name: 'Inbox', kind: 'inbox' as const, unreadCount: 0, totalCount: 0 },
  {
    providerId: 'Label_1',
    name: 'Receipts',
    kind: 'custom' as const,
    unreadCount: 0,
    totalCount: 0,
  },
]

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@x.com') RETURNING id`,
    [USER],
  )
  accountId = a!.id
})

afterAll(() => t.close())

const apply = (b: Partial<SyncBatch>) =>
  applySyncBatch(db, { userId: USER, accountId, batch: batch(b) })

describe('sync store', () => {
  let seqAfterFirst = 0

  it('builds threads, aggregates and folder membership from messages', async () => {
    await apply({
      folders: FOLDERS,
      messages: [
        msg('m1', 't1', { date: new Date('2026-10-10T10:00:00Z'), subject: 'Q4 plan' }),
        msg('m2', 't1', {
          from: { name: 'Lee', email: 'lee@x.com' },
          unread: true,
          folderIds: ['INBOX', 'Label_1'],
          attachments: [
            {
              filename: 'a.pdf',
              mime: 'application/pdf',
              size: 9,
              providerAttachmentId: 'att',
              contentId: null,
              inline: false,
            },
          ],
          hasAttachments: true,
        }),
        msg('m3', 't2', { folderIds: ['SENT_UNKNOWN'] }),
      ],
    })
    const delta = await readDelta(db, USER, 0)
    seqAfterFirst = delta.seq
    expect(delta.more).toBe(false)
    expect(delta.upserts.folders.map((f) => f.name).sort()).toEqual(['Inbox', 'Receipts'])
    expect(delta.upserts.messages).toHaveLength(3)

    const t1 = delta.upserts.threads.find((t) => t.subject === 'Q4 plan')!
    expect(t1).toMatchObject({
      messageCount: 2,
      unread: true,
      hasAttachments: true,
      snippet: 'snippet m2',
    })
    expect(t1.participants.map((p) => p.email)).toEqual(['lee@x.com', 'ana@x.com'])
    expect(t1.lastMessageAt).toBe(Date.parse('2026-10-12T10:00:00Z'))
    expect(t1.folderIds).toHaveLength(2)

    const [{ n }] = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM attachments`,
    )) as [{ n: number }]
    expect(n).toBe(1)
  })

  it('records nothing when a batch changes nothing', async () => {
    await apply({
      folders: FOLDERS,
      messages: [msg('m1', 't1', { date: new Date('2026-10-10T10:00:00Z'), subject: 'Q4 plan' })],
    })
    const delta = await readDelta(db, USER, seqAfterFirst)
    expect(delta.seq).toBe(seqAfterFirst)
    expect(delta.upserts.threads).toHaveLength(0)
  })

  it('propagates label changes and deletions, dropping emptied threads', async () => {
    await apply({
      messages: [
        msg('m2', 't1', {
          from: { name: 'Lee', email: 'lee@x.com' },
          folderIds: ['Label_1'],
          unread: false,
        }),
      ],
      deletedMessageIds: ['m3'],
    })
    const delta = await readDelta(db, USER, seqAfterFirst)
    expect(delta.deletes.message).toHaveLength(1)
    expect(delta.deletes.thread).toHaveLength(1)
    const t1 = delta.upserts.threads[0]!
    expect(t1.unread).toBe(false)
    // m1 is still in INBOX, so the thread keeps both folders.
    expect(t1.folderIds).toHaveLength(2)
  })

  it('removes folders that disappeared and re-sends affected threads', async () => {
    const before = (await readDelta(db, USER, 0)).seq
    await apply({ folders: [FOLDERS[0]!] })
    const delta = await readDelta(db, USER, before)
    expect(delta.deletes.folder).toHaveLength(1)
    expect(delta.upserts.threads[0]!.folderIds).toHaveLength(1)
  })

  it('pages deltas with `more` and compacts repeated changes', async () => {
    const delta = await readDelta(db, USER, 0, 3)
    expect(delta.more).toBe(true)
    const rest = await readDelta(db, USER, delta.seq)
    expect(rest.more).toBe(false)
    expect(rest.seq).toBeGreaterThan(delta.seq)
  })

  it('records account updates', async () => {
    const before = (await readDelta(db, USER, 0)).seq
    await updateAccount(db, accountId, {
      status: 'active',
      syncState: { historyId: '42' },
      lastSyncedAt: new Date(),
    })
    const delta = await readDelta(db, USER, before)
    expect(delta.upserts.accounts[0]).toMatchObject({ status: 'active', email: 'zach@x.com' })
  })

  it('bootstraps recent threads in chunks with a consistent seq', async () => {
    for (let i = 0; i < 5; i++) {
      await apply({
        messages: [msg(`b${i}`, `bt${i}`, { date: new Date(Date.now() - i * 60_000) })],
      })
    }
    await apply({ messages: [msg('old', 'old', { date: new Date('2020-01-01') })] })
    const chunks: Partial<Rows>[] = []
    const seq = await readBootstrap(db, USER, 90, (r) => chunks.push(r), 2)
    expect(seq).toBe((await readDelta(db, USER, 0, 100000)).seq)
    const threads = chunks.flatMap((c) => c.threads ?? [])
    expect(threads.map((t) => t.id)).not.toContain(undefined)
    expect(threads.some((t) => t.subject === 'Subject old')).toBe(false)
    expect(new Set(threads.map((t) => t.id)).size).toBe(threads.length)
    expect(threads.length).toBeGreaterThanOrEqual(5)
    expect(chunks[0]!.accounts).toHaveLength(1)
  })
})

describe('contacts', () => {
  it('ranks people Zach writes to above people who write to him, without himself', async () => {
    await apply({
      folders: [
        ...FOLDERS,
        { providerId: 'SENT', name: 'Sent', kind: 'sent', unreadCount: 0, totalCount: 0 },
      ],
      messages: [
        msg('c1', 'tc', {
          from: { email: 'zach@x.com' },
          to: [{ name: 'Bo Lee', email: 'Bo@y.com' }],
          folderIds: ['SENT'],
        }),
        msg('c2', 'tc', { from: { name: 'Cy', email: 'cy@z.com' }, to: [{ email: 'zach@x.com' }] }),
      ],
    })
    const contacts = await readContacts(db, USER)
    const emails = contacts.map((c) => c.email)
    expect(emails.indexOf('bo@y.com')).toBeLessThan(emails.indexOf('cy@z.com'))
    expect(emails).not.toContain('zach@x.com')
    expect(contacts.find((c) => c.email === 'bo@y.com')).toMatchObject({ name: 'Bo Lee' })
  })
})
