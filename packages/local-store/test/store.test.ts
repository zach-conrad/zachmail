import type { FolderRow, MessageRow, OpEnvelope, SplitRuleRow, ThreadRow } from '@zachmail/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { openSqliteWasm } from '../src/sqlite-wasm'
import { SqlStore } from '../src/store'

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
const thread = (id: string, at: number, folderIds = ['inbox']): ThreadRow => ({
  id,
  accountId: 'a1',
  subject: `Subject ${id}`,
  snippet: 'snip',
  participants: [{ name: 'Ana', email: 'ana@example.com' }],
  lastMessageAt: at,
  messageCount: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
  folderIds,
})
const message = (id: string, threadId: string, date: number, extra: Partial<MessageRow> = {}) =>
  ({
    id,
    threadId,
    accountId: 'a1',
    from: { name: 'Ana', email: 'ana@example.com' },
    to: [],
    cc: [],
    replyTo: [],
    subject: 's',
    snippet: 's',
    date,
    unread: false,
    starred: false,
    hasAttachments: false,
    listUnsubscribe: null,
    rfc822MessageId: null,
    bodyStatus: 'none',
    ...extra,
  }) satisfies MessageRow

let store: SqlStore

beforeEach(async () => {
  store = new SqlStore((await openSqliteWasm()).driver)
  store.apply(
    { accounts: [account], folders: [folder('inbox', 'inbox'), folder('imp', 'important')] },
    null,
    null,
  )
})

describe('SqlStore', () => {
  it('applies rows, records seq and lists threads newest first', () => {
    expect(store.getSeq()).toBeNull()
    store.apply(
      {
        threads: [thread('t1', 1, ['inbox', 'imp']), thread('t2', 2, ['inbox', 'imp'])],
        messages: [message('m1', 't1', 1), message('m2', 't2', 2)],
      },
      null,
      7,
    )
    expect(store.getSeq()).toBe(7)
    const q = { split: 'important' as const }
    expect(store.countThreads(q)).toBe(2)
    expect(store.listThreads(q, 0, 10).map((t) => t.id)).toEqual(['t2', 't1'])
    expect(store.indexOfThread(q, 't1')).toBe(1)
    expect(store.indexOfThread({ split: 'other' }, 't1')).toBe(-1)
  })

  it('classifies splits from folders, List-Unsubscribe and automated senders', () => {
    store.apply(
      {
        threads: [
          thread('imp', 4, ['inbox', 'imp']),
          thread('oth', 3),
          thread('news', 2),
          thread('note', 1),
          thread('done', 0, []),
        ],
        messages: [
          message('m1', 'imp', 4),
          message('m2', 'oth', 3),
          message('m3', 'news', 2, { listUnsubscribe: '<mailto:u@x.com>' }),
          message('m4', 'note', 1, { from: { email: 'notifications@github.com' } }),
          message('m5', 'done', 0),
        ],
      },
      null,
      1,
    )
    const ids = (split: 'important' | 'other' | 'newsletters' | 'notifications') =>
      store.listThreads({ split }, 0, 10).map((t) => t.id)
    expect(ids('important')).toEqual(['imp'])
    expect(ids('other')).toEqual(['oth'])
    expect(ids('newsletters')).toEqual(['news'])
    expect(ids('notifications')).toEqual(['note'])
  })

  it('reclassifies when a message arrives later and removes deleted threads', () => {
    store.apply({ threads: [thread('t', 1)] }, null, 1)
    expect(store.countThreads({ split: 'other' })).toBe(1)
    store.apply({ messages: [message('m', 't', 1, { listUnsubscribe: 'x' })] }, null, 2)
    expect(store.countThreads({ split: 'newsletters' })).toBe(1)
    store.apply({}, { thread: ['t'] }, 3)
    expect(store.countThreads({ split: 'newsletters' })).toBe(0)
    expect(store.getThread('t')).toBeNull()
  })

  it('returns thread detail with cached bodies and reports missing ones', () => {
    store.apply(
      {
        threads: [thread('t', 3)],
        messages: [
          message('old', 't', 1),
          message('unread', 't', 2, { unread: true }),
          message('latest', 't', 3),
        ],
      },
      null,
      1,
    )
    expect(
      store
        .bodiesMissing(['t'])
        .map((m) => m.messageId)
        .sort(),
    ).toEqual(['latest', 'unread'])
    store.putBodies([{ messageId: 'latest', html: '<p>hi</p>', hasRemoteImages: false }])
    expect(store.bodiesMissing(['t'])).toEqual([{ messageId: 'unread', threadId: 't' }])
    const d = store.getThread('t')!
    expect(d.messages.map((m) => m.id)).toEqual(['old', 'unread', 'latest'])
    expect(d.bodies.latest?.html).toBe('<p>hi</p>')
  })

  it('counts unread threads and lists the ones newer than a cursor', () => {
    store.apply(
      { threads: [thread('a', 10), { ...thread('b', 20), unread: false }, thread('c', 30)] },
      null,
      1,
    )
    const r = store.unread({ split: 'other' }, 15, 5)
    expect(r.count).toBe(2)
    expect(r.fresh.map((t) => t.id)).toEqual(['c'])
  })

  it('reset clears synced data and the cursor', () => {
    store.apply({ threads: [thread('t', 1)] }, null, 5)
    store.reset()
    expect(store.getSeq()).toBeNull()
    expect(store.countThreads({ split: 'other' })).toBe(0)
  })
})

describe('SqlStore pending ops', () => {
  const env = (id: string, op: OpEnvelope['op']): OpEnvelope => ({ id, op, at: 1 })
  const seed = () =>
    store.apply(
      {
        folders: [folder('arch', 'archive')],
        threads: [thread('t1', 1, ['inbox', 'imp']), thread('t2', 2, ['inbox', 'imp'])],
        messages: [message('m1', 't1', 1), message('m2', 't2', 2)],
      },
      null,
      1,
    )
  const ids = () => store.listThreads({ split: 'important' }, 0, 10).map((t) => t.id)

  it('applies an op locally at once and keeps it over fresh server rows', () => {
    seed()
    store.enqueueOp(env('o1', { kind: 'archive', threadIds: ['t2'] }))
    expect(ids()).toEqual(['t1'])
    expect(store.unsentOps(10).map((e) => e.id)).toEqual(['o1'])
    // A delta that predates the op still shows t2 in the inbox; the overlay wins.
    store.apply({ threads: [thread('t2', 3, ['inbox', 'imp'])] }, null, 2)
    expect(ids()).toEqual(['t1'])
    expect(store.getThread('t2')!.thread.lastMessageAt).toBe(3)
  })

  it('restores server state when an op fails, and drops it when done', () => {
    seed()
    store.enqueueOp(env('o1', { kind: 'archive', threadIds: ['t1'] }))
    store.enqueueOp(env('o2', { kind: 'read', threadIds: ['t2'] }))
    store.markOpsSent(['o1', 'o2'])
    expect(store.unsentOps(10)).toEqual([])
    store.apply({}, null, 2, [{ id: 'o1', state: 'failed', error: 'nope' }])
    expect(ids()).toEqual(['t2', 't1'])
    // The server applied o2 and says so in the same delta.
    store.apply({ threads: [{ ...thread('t2', 2, ['inbox', 'imp']), unread: false }] }, null, 3, [
      { id: 'o2', state: 'done', error: null },
    ])
    expect(store.listThreads({ split: 'important' }, 0, 1)[0]).toMatchObject({ unread: false })
  })

  it('reapplies queued ops in order, and folds them in with keep', () => {
    seed()
    store.enqueueOp(env('o1', { kind: 'archive', threadIds: ['t1'] }))
    store.enqueueOp(env('o2', { kind: 'inbox', threadIds: ['t1'] }))
    expect(ids()).toEqual(['t2', 't1'])
    store.settleOps(['o2'])
    expect(ids()).toEqual(['t2'])
    store.settleOps(['o1'], true)
    expect(ids()).toEqual(['t2'])
    store.apply({ threads: [thread('t2', 2, ['inbox', 'imp'])] }, null, 2)
    expect(store.unsentOps(10)).toEqual([])
  })

  it('keeps unsent ops across a fresh bootstrap', () => {
    seed()
    store.enqueueOp(env('o1', { kind: 'archive', threadIds: ['t1'] }))
    store.enqueueOp(env('o2', { kind: 'star', threadIds: ['t2'] }))
    store.markOpsSent(['o2'])
    store.reset()
    store.apply(
      { accounts: [account], folders: [folder('inbox', 'inbox'), folder('imp', 'important')] },
      null,
      null,
    )
    seed()
    expect(ids()).toEqual(['t2'])
    expect(store.unsentOps(10).map((e) => e.id)).toEqual(['o1'])
  })
})

describe('split rules', () => {
  const RULE: SplitRuleRow = {
    id: 'r1',
    name: 'Stripe',
    target: 'custom',
    match: 'all',
    conditions: [{ field: 'domain', value: 'stripe.com' }],
    position: 1,
  }
  const inSplit = (split: string) => store.listThreads({ split }, 0, 10).map((t) => t.id)
  const settle = () => {
    while (store.resplitStep()) {
      // steps until nothing is left to move
    }
  }

  beforeEach(() => {
    store.apply(
      {
        threads: [thread('t1', 1, ['inbox', 'imp']), thread('t2', 2, ['inbox', 'imp'])],
        messages: [
          message('m1', 't1', 1, { from: { email: 'ana@stripe.com' } }),
          message('m2', 't2', 2, { cc: [{ email: 'Team@Work.example' }] }),
        ],
      },
      null,
      1,
    )
  })

  it('re-splits at once on a local edit and keeps it over stale synced rows', () => {
    expect(inSplit('important')).toEqual(['t2', 't1'])
    store.editSplitRule(RULE.id, RULE)
    settle()
    expect(inSplit('r1')).toEqual(['t1'])
    expect(store.splitRules()).toEqual([RULE])
    // A delta from before the edit reached the server does not undo it on screen.
    store.apply({ splitRules: [{ ...RULE, name: 'Old' }] }, null, 2)
    expect(store.splitRules()[0]!.name).toBe('Stripe')

    const [pending] = store.pendingSplitRules()
    store.ackSplitRule(pending!)
    expect(store.pendingSplitRules()).toEqual([])
    expect(store.splitRules()).toEqual([RULE])
    expect(inSplit('r1')).toEqual(['t1'])

    store.apply({}, { splitRule: ['r1'] }, 3)
    settle()
    expect(inSplit('important')).toEqual(['t2', 't1'])
  })

  it('drops a rejected edit and keeps unsent edits across a re-bootstrap', () => {
    store.editSplitRule(RULE.id, RULE)
    settle()
    store.reset()
    expect(store.pendingSplitRules()).toHaveLength(1)
    store.rejectSplitRule('r1')
    settle()
    expect(store.splitRules()).toEqual([])
  })

  it('matches recipients only when a rule needs them', () => {
    store.editSplitRule('r2', {
      ...RULE,
      id: 'r2',
      target: 'other',
      conditions: [{ field: 'to', value: 'team@work' }],
    })
    settle()
    expect(inSplit('other')).toEqual(['t2'])
  })

  it('re-splits 20k threads well inside a frame budget for a settings save', () => {
    const n = 20_000
    store.apply(
      {
        threads: Array.from({ length: n }, (_, i) => thread(`b${i}`, 10 + i, ['inbox', 'imp'])),
        messages: Array.from({ length: n }, (_, i) =>
          message(`bm${i}`, `b${i}`, 10 + i, {
            from: { email: i % 3 ? `p${i}@example.com` : `x${i}@stripe.com` },
          }),
        ),
      },
      null,
      4,
    )
    const t0 = performance.now()
    store.editSplitRule(RULE.id, RULE)
    settle()
    const ms = performance.now() - t0
    expect(store.countThreads({ split: 'r1' })).toBe(Math.ceil(n / 3) + 1)
    // Runs in the data worker, off the UI thread; keep it well under a second on CI.
    expect(ms).toBeLessThan(1000)
  })
})
