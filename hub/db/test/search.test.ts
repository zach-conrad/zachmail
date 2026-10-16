import { parseQuery, planQuery } from '@zachhub/core'
import type { ProviderMessage } from '@zachhub/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySyncBatch,
  loadSearchContext,
  mirrorHorizons,
  mirroredThreadIds,
  readThreads,
  searchMirror,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let work: string
let personal: string

const msg = (id: string, thread: string, over: Partial<ProviderMessage> = {}): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: thread,
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

const FOLDERS = [
  { providerId: 'INBOX', name: 'INBOX', kind: 'inbox' as const, unreadCount: 0, totalCount: 0 },
  { providerId: 'TRASH', name: 'TRASH', kind: 'trash' as const, unreadCount: 0, totalCount: 0 },
  {
    providerId: 'L1',
    name: 'Work/Clients',
    kind: 'custom' as const,
    unreadCount: 0,
    totalCount: 0,
  },
]

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const acct = async (email: string, short: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO accounts (user_id, provider, email, short_name) VALUES ($1, 'gmail', $2, $3) RETURNING id`,
        [USER, email, short],
      )
    )[0]!.id
  work = await acct('zach@work.dev', 'Work')
  personal = await acct('zach@gmail.com', 'Personal')
  await applySyncBatch(db, {
    userId: USER,
    accountId: work,
    batch: {
      folders: FOLDERS,
      deletedMessageIds: [],
      messages: [
        msg('w1', 'wt1', { subject: 'Q4 planning', snippet: 'Budget draft attached' }),
        msg('w2', 'wt1', {
          from: { name: 'Zach', email: 'zach@work.dev' },
          to: [{ name: 'Ana Ruiz', email: 'ana@acme.com' }],
          subject: 'Re: Q4 planning',
          snippet: 'Looks good',
          date: new Date('2026-10-02T12:00:00Z'),
        }),
        msg('w3', 'wt2', {
          from: { name: 'Lee', email: 'lee@client.io' },
          subject: 'Invoice 42',
          hasAttachments: true,
          unread: true,
          folderIds: ['L1'],
          date: new Date('2026-09-01T12:00:00Z'),
        }),
        msg('w4', 'wt3', {
          subject: 'Old planning notes',
          folderIds: ['TRASH'],
          date: new Date('2026-08-01T12:00:00Z'),
        }),
      ],
    },
  })
  await applySyncBatch(db, {
    userId: USER,
    accountId: personal,
    batch: {
      folders: [FOLDERS[0]!],
      deletedMessageIds: [],
      messages: [
        msg('p1', 'pt1', {
          from: { name: 'Café Ünïon', email: 'news@cafe.fr' },
          to: [{ email: 'zach@gmail.com' }],
          subject: 'Weekly menu',
          date: new Date('2025-01-05T12:00:00Z'),
        }),
      ],
    },
  })
})

afterAll(() => t.close())

async function search(q: string, opts: { olderThan?: number } = {}) {
  const plan = planQuery(parseQuery(q, { tzOffset: 0 }), await loadSearchContext(db, USER))
  if (!plan) return []
  const rows = await searchMirror(db, USER, plan, { limit: 50, ...opts })
  return rows.map((r) => r.subject)
}

describe('mirror search', () => {
  it('matches free text by prefix across subject, people and body, hiding trash', async () => {
    expect(await search('plan')).toEqual(['Q4 planning'])
    expect(await search('budg')).toEqual(['Q4 planning'])
    expect(await search('acme')).toEqual(['Q4 planning'])
    expect(await search('café')).toEqual(['Weekly menu'])
    expect(await search('in:trash plan')).toEqual(['Old planning notes'])
  })

  it('field operators are per message, like Gmail', async () => {
    expect(await search('from:lee')).toEqual(['Invoice 42'])
    expect(await search('from:client.io')).toEqual(['Invoice 42'])
    expect(await search('to:ana')).toEqual(['Q4 planning'])
    expect(await search('subject:invoice')).toEqual(['Invoice 42'])
    // "looks" is in w2, sent by me; "budget" is in w1, from Ana. No one message has both.
    expect(await search('looks budget')).toEqual([])
    expect(await search('from:me looks')).toEqual(['Q4 planning'])
    expect(await search('"q4 planning" -draft')).toEqual(['Q4 planning'])
  })

  it('flags, dates, labels and accounts', async () => {
    expect(await search('has:attachment is:unread')).toEqual(['Invoice 42'])
    expect(await search('label:work-clients')).toEqual(['Invoice 42'])
    expect(await search('in:inbox before:2026/01/01')).toEqual(['Weekly menu'])
    expect(await search('after:2026/09/15 account:work')).toEqual(['Q4 planning'])
    expect(await search('in:done')).toEqual(['Invoice 42'])
    expect(await search('-account:work in:anywhere')).toEqual(['Weekly menu'])
  })

  it('pages by keyset and skips what the replica already has', async () => {
    const plan = planQuery(parseQuery('in:anywhere -zzz'), await loadSearchContext(db, USER))!
    const first = await searchMirror(db, USER, plan, { limit: 2 })
    expect(first.map((r) => r.subject)).toEqual(['Q4 planning', 'Invoice 42'])
    const last = first.at(-1)!
    const next = await searchMirror(db, USER, plan, {
      limit: 2,
      after: { at: last.lastMessageAt, id: last.id },
    })
    expect(next.map((r) => r.subject)).toEqual(['Old planning notes', 'Weekly menu'])
    expect(
      await search('in:anywhere -zzz', { olderThan: Date.parse('2026-09-15T00:00:00Z') }),
    ).toEqual(['Invoice 42', 'Old planning notes', 'Weekly menu'])
  })

  it('indexes bodies as they are cached', async () => {
    expect(await search('quarterly')).toEqual([])
    const [m] = await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE provider_message_id = 'w3'`,
    )
    await db.query(
      `INSERT INTO message_bodies (message_id, user_id, html, text) VALUES ($1, $2, '<p>The <b>quarterly</b> numbers</p>', NULL)`,
      [m!.id, USER],
    )
    expect(await search('quarterly')).toEqual(['Invoice 42'])
    expect(await search('numbers')).toEqual(['Invoice 42'])
  })

  it('reads result threads with their messages, and mirror bookkeeping', async () => {
    const ids = await mirroredThreadIds(db, work, ['wt1', 'nope'])
    expect([...ids.keys()]).toEqual(['wt1'])
    const r = await readThreads(db, USER, [ids.get('wt1')!])
    expect(r.threads[0]!.subject).toBe('Q4 planning')
    expect(r.messages).toHaveLength(2)
    const h = await mirrorHorizons(db, USER)
    expect(h.get(personal)).toBe(Date.parse('2025-01-05T12:00:00Z'))
  })
})
