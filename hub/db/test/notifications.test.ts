import type { ProviderMessage, SyncBatch } from '@zachhub/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySyncBatch,
  deleteDevice,
  deleteDevicesById,
  importantUnreadCount,
  listDevices,
  readNotificationSettings,
  readNotifyMessages,
  saveNotificationSettings,
  upsertDevice,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let accountId: string
const HOUR = 3_600_000

const msg = (id: string, thread: string, over: Partial<ProviderMessage> = {}): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: thread,
  rfc822MessageId: `<${id}@x>`,
  inReplyTo: null,
  references: [],
  from: { name: 'Ana', email: 'Ana@x.com' },
  to: [{ email: 'zach@x.com' }],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: `Subject ${thread}`,
  snippet: `snippet ${id}`,
  date: new Date(Date.now() - 60_000),
  folderIds: ['INBOX'],
  unread: true,
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

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@x.com') RETURNING id`,
    [USER],
  )
  accountId = a!.id
  await apply({
    folders: [{ providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0, totalCount: 0 }],
  })
})

afterAll(() => t.close())

describe('notification data', () => {
  it('reports newly inserted messages only', async () => {
    const first = await apply({ messages: [msg('m1', 't1')] })
    expect(first.inserted).toHaveLength(1)
    const again = await apply({ messages: [msg('m1', 't1', { unread: false })] })
    expect(again.inserted).toEqual([])
  })

  it('reads fresh inbound messages with their thread split, newest first', async () => {
    const { inserted } = await apply({
      messages: [
        msg('n1', 'human'),
        msg('n2', 'news', { listUnsubscribe: '<mailto:u@x>', date: new Date(Date.now() - 1000) }),
        msg('n3', 'mine', { from: { email: 'Zach@x.com' } }),
        msg('n4', 'stale', { date: new Date(Date.now() - 5 * HOUR) }),
      ],
    })
    const rows = await readNotifyMessages(db, USER, inserted, 2 * HOUR)
    expect(rows.map((r) => [r.threadId.length > 0, r.split, r.fromEmail, r.subject])).toEqual([
      [true, 'newsletters', 'ana@x.com', 'Subject news'],
      [true, 'important', 'ana@x.com', 'Subject human'],
    ])
    expect(rows[0]).toMatchObject({ accountId, muted: false, unread: true, fromName: 'Ana' })
    // human, mine and stale; t1 was read.
    expect(await importantUnreadCount(db, USER)).toBe(3)
  })

  it('stores settings with defaults', async () => {
    expect(await readNotificationSettings(db, USER)).toEqual({
      enabled: true,
      splits: ['important'],
      vips: [],
      mutedAccounts: [],
    })
    const s = { enabled: true, splits: ['important', 'other'], vips: ['@x.com'], mutedAccounts: [] }
    await saveNotificationSettings(db, USER, s)
    await saveNotificationSettings(db, USER, { ...s, enabled: false })
    expect(await readNotificationSettings(db, USER)).toEqual({ ...s, enabled: false })
  })

  it('registers devices idempotently and forgets gone ones', async () => {
    const d = {
      kind: 'webpush' as const,
      token: 'https://push.example/abc',
      keys: { p256dh: 'p', auth: 'a' },
      label: 'Chrome',
    }
    expect(await upsertDevice(db, USER, d)).toBe(true)
    expect(await upsertDevice(db, USER, { ...d, keys: { p256dh: 'p2', auth: 'a2' } })).toBe(true)
    const [row] = await listDevices(db, USER, 'webpush')
    expect(row).toMatchObject({ token: d.token, keys: { p256dh: 'p2', auth: 'a2' } })
    await deleteDevicesById(db, [row!.id])
    expect(await listDevices(db, USER, 'webpush')).toEqual([])
    await upsertDevice(db, USER, d)
    await deleteDevice(db, USER, d.token)
    expect(await listDevices(db, USER, 'webpush')).toEqual([])
  })
})
