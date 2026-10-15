import type { ProviderMessage, SyncBatch } from '@zachmail/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySyncBatch,
  deleteSplitRule,
  readBootstrap,
  readDelta,
  recomputeSplits,
  upsertSplitRule,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let accountId: string

const RULE = '4b7a1c1e-0000-4000-8000-000000000001'

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

const apply = (b: Partial<SyncBatch>) =>
  applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: { messages: [], deletedMessageIds: [], ...b },
  })

const splits = async () =>
  Object.fromEntries(
    (
      await db.query<{ provider_thread_id: string; split: string | null }>(
        `SELECT provider_thread_id, split FROM threads ORDER BY provider_thread_id`,
      )
    ).map((r) => [r.provider_thread_id, r.split]),
  )

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

describe('server split evaluation', () => {
  it('classifies on ingest with the built-in rules', async () => {
    await apply({
      folders: [
        { providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0, totalCount: 0 },
        { providerId: 'SENT', name: 'Sent', kind: 'sent', unreadCount: 0, totalCount: 0 },
      ],
      messages: [
        msg('m1', 'human'),
        // The user's own reply is newest; the split still follows the other person.
        msg('m1b', 'human', {
          from: { email: 'zach@x.com' },
          date: new Date('2026-10-13T10:00:00Z'),
          folderIds: ['SENT'],
        }),
        msg('m2', 'news', { listUnsubscribe: '<mailto:u@x>' }),
        msg('m3', 'bot', { from: { email: 'noreply@stripe.com' } }),
        msg('m4', 'archived', { folderIds: [] }),
      ],
    })
    // No "important" label on this account, so every human lands in Important.
    expect(await splits()).toEqual({
      archived: null,
      bot: 'notifications',
      human: 'important',
      news: 'newsletters',
    })
  })

  it('user rules run first, and a rule change re-splits every inbox thread', async () => {
    expect(
      await upsertSplitRule(db, USER, {
        id: RULE,
        name: 'Stripe',
        target: 'custom',
        match: 'all',
        conditions: [{ field: 'domain', value: 'stripe.com' }],
        position: 1,
      }),
    ).toBe(true)
    expect(await recomputeSplits(db, USER, null)).toBe(1)
    expect((await splits()).bot).toBe(RULE)

    const delta = await readDelta(db, USER, 0)
    expect(delta.upserts.splitRules).toEqual([
      {
        id: RULE,
        name: 'Stripe',
        target: 'custom',
        match: 'all',
        conditions: [{ field: 'domain', value: 'stripe.com' }],
        position: 1,
      },
    ])

    let boot: unknown[] = []
    await readBootstrap(db, USER, 3650, (rows) => {
      if (rows.splitRules) boot = rows.splitRules
    })
    expect(boot).toHaveLength(1)

    // New mail matching the rule is split on ingest.
    await apply({ messages: [msg('m5', 'bot2', { from: { email: 'billing@stripe.com' } })] })
    expect((await splits()).bot2).toBe(RULE)
  })

  it('recipient rules gather recipients', async () => {
    await upsertSplitRule(db, USER, {
      id: '4b7a1c1e-0000-4000-8000-000000000002',
      name: 'Work alias',
      target: 'other',
      match: 'any',
      conditions: [{ field: 'to', value: 'zach@x.com' }],
      position: 0,
    })
    await recomputeSplits(db, USER, null)
    const s = await splits()
    expect(s.human).toBe('other')
    expect(s.news).toBe('other')
    await deleteSplitRule(db, USER, '4b7a1c1e-0000-4000-8000-000000000002')
    await recomputeSplits(db, USER, null)
    expect((await splits()).human).toBe('important')
  })

  it('deleting a rule syncs a delete and returns its threads to the built-ins', async () => {
    const { seq } = await readDelta(db, USER, 0)
    await deleteSplitRule(db, USER, RULE)
    await recomputeSplits(db, USER, null)
    expect((await splits()).bot).toBe('notifications')
    const delta = await readDelta(db, USER, seq)
    expect(delta.deletes.splitRule).toEqual([RULE])
  })

  it("never overwrites another user's rule", async () => {
    const other = '00000000-0000-0000-0000-000000000002'
    await t.exec(`INSERT INTO auth.users VALUES ('${other}', 'other@example.com')`)
    const rule = {
      id: RULE,
      name: 'Mine',
      target: 'important' as const,
      match: 'all' as const,
      conditions: [{ field: 'from' as const, value: 'a' }],
      position: 0,
    }
    expect(await upsertSplitRule(db, other, rule)).toBe(true)
    expect(await upsertSplitRule(db, USER, { ...rule, name: 'Stolen' })).toBe(false)
    const [r] = await db.query<{ name: string }>(`SELECT name FROM split_rules WHERE id = $1`, [
      RULE,
    ])
    expect(r!.name).toBe('Mine')
  })
})
