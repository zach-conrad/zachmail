import type { FolderRow, MessageRow, ThreadRow } from '@zachhub/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { SearchIndex, htmlToText } from '../src/search'
import { openSqliteWasm } from '../src/sqlite-wasm'
import { SqlStore } from '../src/store'
import type { SqlDriver } from '../src/driver'

const account = {
  id: 'a1',
  provider: 'gmail' as const,
  email: 'zach@example.com',
  displayName: 'Zach',
  shortName: 'Personal',
  color: 0,
  status: 'ok',
  lastSyncedAt: null,
  lastError: null,
}
const folder = (id: string, kind: FolderRow['kind'], name = id): FolderRow => ({
  id,
  accountId: 'a1',
  providerId: id,
  name,
  kind,
  unreadCount: 0,
  totalCount: 0,
})
const thread = (
  id: string,
  at: number,
  subject: string,
  folderIds = ['inbox'],
  extra: Partial<ThreadRow> = {},
): ThreadRow => ({
  id,
  accountId: 'a1',
  subject,
  snippet: '',
  participants: [],
  lastMessageAt: at,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  folderIds,
  ...extra,
})
const message = (id: string, threadId: string, date: number, extra: Partial<MessageRow> = {}) =>
  ({
    id,
    threadId,
    accountId: 'a1',
    from: { name: 'Ana Ruiz', email: 'ana@acme.com' },
    to: [{ email: 'zach@example.com' }],
    cc: [],
    replyTo: [],
    subject: 'Hello',
    snippet: '',
    date,
    unread: false,
    starred: false,
    hasAttachments: false,
    listUnsubscribe: null,
    rfc822MessageId: null,
    bodyStatus: 'none',
    ...extra,
  }) satisfies MessageRow

let driver: SqlDriver
let store: SqlStore
let index: SearchIndex
const titles = (search: string) =>
  index.listThreads({ search, tzOffset: 0 }, 0, 50).map((t) => t.subject)

beforeEach(async () => {
  driver = (await openSqliteWasm()).driver
  store = new SqlStore(driver)
  index = new SearchIndex(driver, store)
  store.apply(
    {
      accounts: [account],
      folders: [
        folder('inbox', 'inbox'),
        folder('trash', 'trash'),
        folder('l1', 'custom', 'Work/Clients'),
      ],
      threads: [
        thread('t1', 3, 'Q4 planning'),
        thread('t2', 2, 'Invoice 42', ['l1'], { unread: true, hasAttachments: true }),
        thread('t3', 1, 'Old planning notes', ['trash']),
      ],
      messages: [
        message('m1', 't1', 3, { subject: 'Q4 planning', snippet: 'Budget draft attached' }),
        message('m1b', 't1', 4, {
          from: { name: 'Zach', email: 'zach@example.com' },
          to: [{ name: 'Ana Ruiz', email: 'ana@acme.com' }],
          snippet: 'Looks good',
        }),
        message('m2', 't2', Date.UTC(2026, 8, 1), {
          from: { name: 'Lee', email: 'lee@client.io' },
          subject: 'Invoice 42',
          unread: true,
          hasAttachments: true,
        }),
        message('m3', 't3', 1, { subject: 'Old planning notes' }),
      ],
    },
    null,
    1,
  )
})

describe('SearchIndex', () => {
  it('matches like the server: prefixes, fields, per-message, trash hidden', () => {
    expect(titles('plan')).toEqual(['Q4 planning'])
    expect(titles('in:trash plan')).toEqual(['Old planning notes'])
    expect(titles('from:client.io')).toEqual(['Invoice 42'])
    expect(titles('to:ana')).toEqual(['Q4 planning'])
    expect(titles('looks budget')).toEqual([])
    expect(titles('from:me looks')).toEqual(['Q4 planning'])
    expect(titles('"q4 planning" -draft')).toEqual([])
    expect(titles('has:attachment is:unread label:work-clients')).toEqual(['Invoice 42'])
    expect(titles('is:read invoice')).toEqual([])
    expect(titles('after:2026/08/01')).toEqual(['Invoice 42'])
    expect(titles('larger:5M')).toEqual([])
    expect(index.countThreads({ search: 'plan' })).toBe(1)
    expect(index.indexOfThread({ search: 'in:anywhere -zzz' }, 't2')).toBe(1)
    expect(index.indexOfThread({ search: 'plan' }, 't2')).toBe(-1)
  })

  it('keeps the index in step with sync upserts and deletes', () => {
    store.apply({ messages: [message('m2', 't2', 2, { subject: 'Receipt 42' })] }, null, 2)
    expect(titles('invoice')).toEqual([])
    expect(titles('receipt')).toEqual(['Invoice 42'])
    store.apply({}, { thread: ['t2'] }, 3)
    expect(titles('receipt')).toEqual([])
  })

  it('indexes cached bodies, survives re-synced messages, and drops them with the body', () => {
    store.putBodies([
      { messageId: 'm2', html: '<p>The <b>quarterly</b> numbers</p>', hasRemoteImages: false },
    ])
    index.indexBodies([
      { messageId: 'm2', html: '<p>The <b>quarterly</b> numbers</p>', hasRemoteImages: false },
    ])
    expect(titles('quarterly')).toEqual(['Invoice 42'])
    store.apply({ messages: [message('m2', 't2', 2, { subject: 'Invoice 42' })] }, null, 2)
    expect(titles('quarterly')).toEqual(['Invoice 42'])
    store.apply({}, { message: ['m2'] }, 3)
    expect(titles('quarterly')).toEqual([])
  })

  it('builds the index for a replica that predates it', async () => {
    driver.exec(`DELETE FROM meta WHERE key = 'search_index'`)
    store.putBodies([
      { messageId: 'm1', html: '<style>.x{}</style>Hi &amp; bye', hasRemoteImages: false },
    ])
    index = new SearchIndex(driver, store)
    expect(titles('bye')).toEqual(['Q4 planning'])
    expect(titles('budget')).toEqual(['Q4 planning'])
  })

  it('merges server results: new threads to apply, all kept as matches', () => {
    const q = { search: 'zebra' }
    const fresh = thread('t9', 0, 'Old zebra')
    const add = index.addRemote(q, {
      threads: [fresh, thread('t1', 3, 'Q4 planning')],
      messages: [message('m9', 't9', 0), message('m1', 't1', 3)],
    })
    expect(add.threads.map((t) => t.id)).toEqual(['t9'])
    expect(add.messages.map((m) => m.id)).toEqual(['m9'])
    store.apply(add, null, null)
    // t1 doesn't contain "zebra" locally (the server matched an uncached body), still shown.
    expect(titles('zebra')).toEqual(['Q4 planning', 'Old zebra'])
    expect(titles('zebra other')).toEqual([])
  })

  it('warms in steps', () => {
    expect([...index.warming()].length).toBeGreaterThan(4)
  })

  it('strips HTML to text', () => {
    expect(htmlToText('<style>p{color:red}</style><p>a&nbsp;&lt;b&gt; &#233;&#x41;</p>')).toBe(
      'a <b> éA',
    )
  })
})
