import type { FolderRow, MessageRow, SnippetRow, ThreadRow } from '@zachhub/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openSqliteWasm } from '../src/sqlite-wasm'
import { SqlStore } from '../src/store'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-14T12:00:00Z')

const account = {
  id: 'a1',
  provider: 'gmail' as const,
  email: 'zach@example.com',
  displayName: 'Zach',
  shortName: null,
  color: 0,
  status: 'ok',
  lastSyncedAt: null,
  lastError: null,
}
const folder = (id: string, kind: FolderRow['kind']): FolderRow => ({
  id,
  accountId: 'a1',
  providerId: id,
  name: id,
  kind,
  unreadCount: 0,
  totalCount: 0,
})
const thread = (id: string, at: number, folderIds = ['sent']): ThreadRow => ({
  id,
  accountId: 'a1',
  subject: `Subject ${id}`,
  snippet: 'snip',
  participants: [],
  lastMessageAt: at,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  folderIds,
})
const sent = (id: string, threadId: string, date: number, extra: Partial<MessageRow> = {}) =>
  ({
    id,
    threadId,
    accountId: 'a1',
    from: { email: 'Zach@example.com' },
    to: [{ name: 'Ana', email: 'ana@example.com' }],
    cc: [],
    replyTo: [],
    subject: 's',
    snippet: 'Can you take a look?',
    date,
    unread: false,
    starred: false,
    hasAttachments: false,
    listUnsubscribe: null,
    rfc822MessageId: null,
    bodyStatus: 'none',
    ...extra,
  }) satisfies MessageRow

const SNIPPET: SnippetRow = {
  id: 's1',
  name: 'Call',
  shortcut: 'call',
  subject: '',
  html: '<p>Hi</p>',
  cc: [],
  bcc: [],
  updatedAt: 1,
}

let store: SqlStore

beforeEach(async () => {
  store = new SqlStore((await openSqliteWasm()).driver)
  store.apply(
    { accounts: [account], folders: [folder('sent', 'sent'), folder('trash', 'trash')] },
    null,
    null,
  )
})

describe('snippets', () => {
  it('shows local edits at once and keeps them over stale synced rows', () => {
    store.editSnippet('s1', SNIPPET)
    expect(store.snippets()).toEqual([SNIPPET])
    store.apply({ snippets: [{ ...SNIPPET, name: 'Old' }] }, null, 2)
    expect(store.snippets()[0]!.name).toBe('Call')
    const [edit] = store.composerEdits()
    expect(edit).toMatchObject({ kind: 'snippet', id: 's1' })
    store.ackComposerEdit(edit!)
    expect(store.composerEdits()).toEqual([])
    expect(store.snippets()).toEqual([SNIPPET])
    store.apply({}, { snippet: ['s1'] }, 3)
    expect(store.snippets()).toEqual([])
  })

  it('forgets a rejected edit', () => {
    store.editSnippet('s1', SNIPPET)
    store.rejectComposerEdit(store.composerEdits()[0]!)
    expect(store.snippets()).toEqual([])
  })
})

describe('follow-ups', () => {
  beforeEach(() => {
    store.apply(
      {
        threads: [
          thread('waiting', NOW - 4 * DAY),
          thread('answered', NOW - 5 * DAY),
          thread('fresh', NOW - DAY),
          thread('trashed', NOW - 4 * DAY, ['sent', 'trash']),
        ],
        messages: [
          sent('m1', 'waiting', NOW - 4 * DAY),
          sent('m2', 'answered', NOW - 6 * DAY),
          sent('m3', 'answered', NOW - 5 * DAY, { from: { email: 'ana@example.com' } }),
          sent('m4', 'fresh', NOW - DAY),
          sent('m5', 'trashed', NOW - 4 * DAY),
        ],
      },
      null,
      1,
    )
  })

  it('lists unanswered sends in the window', () => {
    const items = store.followUps(NOW)
    expect(items.map((i) => i.threadId)).toEqual(['waiting'])
    expect(items[0]).toMatchObject({
      messageId: 'm1',
      waitingOn: [{ name: 'Ana', email: 'ana@example.com' }],
      thread: { id: 'waiting', subject: 'Subject waiting' },
    })
  })

  it('dismisses until the thread moves, and restores', () => {
    store.dismissNudges(['waiting'], true)
    expect(store.followUps(NOW)).toEqual([])
    expect(store.composerEdits()).toEqual([
      { kind: 'nudge', id: 'waiting', value: { id: 'waiting', lastMessageAt: NOW - 4 * DAY } },
    ])
    store.dismissNudges(['waiting'], false)
    expect(store.followUps(NOW)).toHaveLength(1)

    store.dismissNudges(['waiting'], true)
    // Zach writes again: the old dismissal no longer covers the thread.
    store.apply(
      {
        threads: [thread('waiting', NOW - 3.5 * DAY)],
        messages: [sent('m6', 'waiting', NOW - 3.5 * DAY)],
      },
      null,
      2,
    )
    expect(store.followUps(NOW).map((i) => i.messageId)).toEqual(['m6'])
  })
})
