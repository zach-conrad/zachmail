import { sentMessageId } from '@zachhub/core'
import type { ProviderMessage } from '@zachhub/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  WAKE_JOB,
  acceptOps,
  acceptSend,
  applySyncBatch,
  cancelSend,
  readDelta,
  wakeDue,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let accountId: string
const thread: Record<string, string> = {}
let inbox: string

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const HOUR = 3_600_000
const base = Date.now() - 24 * HOUR

const msg = (
  id: string,
  threadId: string,
  labels: string[],
  over: Partial<ProviderMessage> = {},
): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: threadId,
  rfc822MessageId: `<${id}@x.com>`,
  inReplyTo: null,
  references: [],
  from: { email: 'ana@x.com' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 's',
  snippet: '',
  date: new Date(base),
  folderIds: labels,
  unread: false,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  size: 1,
  attachments: [],
  ...over,
})

const sync = (messages: ProviderMessage[]) =>
  applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: { messages, deletedMessageIds: [] },
  })

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email, send_as)
     VALUES ($1, 'gmail', 'zach@x.com', '[{"email":"me@alias.com"}]') RETURNING id`,
    [USER],
  )
  accountId = a!.id
  await applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: {
      folders: [
        { providerId: 'INBOX', name: 'INBOX', kind: 'inbox', unreadCount: 0, totalCount: 0 },
      ],
      messages: ['t1', 't2', 't3', 't4'].map((x) => msg(`${x}-m1`, x, ['INBOX'])),
      deletedMessageIds: [],
    },
  })
  for (const r of await db.query<{ id: string; provider_thread_id: string }>(
    `SELECT id, provider_thread_id FROM threads`,
  ))
    thread[r.provider_thread_id] = r.id
  inbox = (await db.query<{ id: string }>(`SELECT id FROM folders WHERE kind = 'inbox'`))[0]!.id
})

afterAll(() => t.close())

const maxSeq = async () =>
  (await db.query<{ s: number }>(`SELECT COALESCE(max(seq), 0)::float8 AS s FROM changes`))[0]!.s

const row = async (key: string) => {
  const delta = await readDelta(db, USER, 0)
  return delta.upserts.threads.find((x) => x.id === thread[key])!
}

/** Moves a thread's snooze or reminder into the past so the next wakeDue picks it up. */
const makeDue = (key: string) =>
  db.query(
    `UPDATE threads SET snoozed_until = now() - interval '1 second'
     WHERE id = $1 AND snoozed_until IS NOT NULL`,
    [thread[key]],
  )
const makeReminderDue = (key: string) =>
  db.query(`UPDATE reminders SET remind_at = now() - interval '1 second' WHERE thread_id = $1`, [
    thread[key],
  ])

describe('snooze', () => {
  it('archives, records snoozed_until and schedules a wake', async () => {
    const until = Date.now() + HOUR
    const since = await maxSeq()
    const r = await acceptOps(db, USER, [
      { id: uuid(1), at: 1, op: { kind: 'snooze', threadIds: [thread.t1!], until } },
    ])
    expect(r.accounts).toEqual([accountId])
    const delta = await readDelta(db, USER, since)
    expect(delta.upserts.threads).toHaveLength(1)
    expect(delta.upserts.threads[0]).toMatchObject({ folderIds: [], snoozedUntil: until })
    const [job] = await db.query<{ run_at_ms: number }>(
      `SELECT (extract(epoch FROM run_at) * 1000)::float8 AS run_at_ms FROM jobs WHERE kind = $1`,
      [WAKE_JOB],
    )
    expect(job!.run_at_ms).toBe(until)
    const [out] = await db.query<{ kind: string; state: string; payload: { remove: string[] } }>(
      `SELECT kind, state, payload FROM outbox WHERE op_id = $1`,
      [uuid(1)],
    )
    expect(out).toMatchObject({ kind: 'snooze', state: 'pending', payload: { remove: [inbox] } })
  })

  it('wakes due threads back into the inbox, unread, exactly once', async () => {
    expect(await wakeDue(db)).toEqual([])
    await makeDue('t1')
    const [r] = await wakeDue(db)
    expect(r).toMatchObject({ userId: USER, accounts: [accountId] })
    expect(await row('t1')).toMatchObject({
      folderIds: [inbox],
      unread: true,
      snoozedUntil: null,
      reminder: null,
    })
    const [out] = await db.query<{ payload: { add: string[]; unread: boolean } }>(
      `SELECT payload FROM outbox WHERE kind = 'unsnooze'`,
    )
    expect(out!.payload).toMatchObject({ add: [inbox], unread: true })
    expect(await wakeDue(db)).toEqual([])
  })

  it('ends the snooze when someone else replies, not when Zach does', async () => {
    await acceptOps(db, USER, [
      {
        id: uuid(2),
        at: 2,
        op: { kind: 'snooze', threadIds: [thread.t2!], until: Date.now() + HOUR },
      },
    ])
    await sync([
      msg('t2-m2', 't2', ['SENT'], {
        from: { email: 'Me@Alias.com' },
        date: new Date(base + HOUR),
      }),
    ])
    expect((await row('t2')).snoozedUntil).not.toBeNull()
    await sync([msg('t2-m3', 't2', ['INBOX'], { date: new Date(base + 2 * HOUR) })])
    expect((await row('t2')).snoozedUntil).toBeNull()
  })

  it('undo (inbox) cancels a snooze without marking it unread', async () => {
    await acceptOps(db, USER, [
      {
        id: uuid(3),
        at: 3,
        op: { kind: 'snooze', threadIds: [thread.t3!], until: Date.now() + HOUR },
      },
      { id: uuid(4), at: 3, op: { kind: 'inbox', threadIds: [thread.t3!] } },
    ])
    expect(await row('t3')).toMatchObject({ folderIds: [inbox], snoozedUntil: null, unread: false })
  })
})

describe('reminders', () => {
  it('stores a reminder with no provider work and reports the op done', async () => {
    const at = Date.now() + HOUR
    const r = await acceptOps(db, USER, [
      {
        id: uuid(10),
        at: 10,
        op: { kind: 'remind', threadIds: [thread.t4!], at, condition: 'if_no_reply' },
      },
    ])
    expect(r).toEqual({ accepted: [uuid(10)], rejected: [], accounts: [] })
    expect(await row('t4')).toMatchObject({
      folderIds: [inbox],
      reminder: { at, condition: 'if_no_reply' },
    })
    expect((await readDelta(db, USER, 0)).ops).toContainEqual({
      id: uuid(10),
      state: 'done',
      error: null,
    })
  })

  it('fires if nobody answered', async () => {
    await acceptOps(db, USER, [
      { id: uuid(11), at: 11, op: { kind: 'archive', threadIds: [thread.t4!] } },
    ])
    await makeReminderDue('t4')
    await wakeDue(db)
    expect(await row('t4')).toMatchObject({ folderIds: [inbox], unread: true, reminder: null })
  })

  it('goes quietly if someone answered', async () => {
    await acceptOps(db, USER, [
      { id: uuid(12), at: 12, op: { kind: 'archive', threadIds: [thread.t4!] } },
      {
        id: uuid(13),
        at: 12,
        op: {
          kind: 'remind',
          threadIds: [thread.t4!],
          at: Date.now() + HOUR,
          condition: 'if_no_reply',
        },
      },
    ])
    await sync([msg('t4-m2', 't4', [], { date: new Date(Date.now() + 1000) })])
    await makeReminderDue('t4')
    const [r] = await wakeDue(db)
    expect(r!.accounts).toEqual([])
    expect(await row('t4')).toMatchObject({ folderIds: [], reminder: null })
  })

  it('links a compose reminder to the thread its sent copy lands in, and undo drops it', async () => {
    const at = Date.now() + HOUR
    const req = (id: string) => ({
      id,
      accountId,
      to: [{ email: 'bo@x.com' }],
      subject: 'hi',
      html: '<p>hi</p>',
      remindAt: at,
    })
    await acceptSend(db, USER, req(uuid(20)))
    const [pending] = await db.query<{ thread_id: string | null }>(
      `SELECT thread_id FROM reminders WHERE op_id = $1`,
      [uuid(20)],
    )
    expect(pending!.thread_id).toBeNull()
    await sync([
      msg('t5-m1', 't5', ['SENT'], {
        from: { email: 'zach@x.com' },
        rfc822MessageId: sentMessageId(uuid(20), 'zach@x.com'),
      }),
    ])
    const [t5] = await db.query<{ id: string }>(
      `SELECT id FROM threads WHERE provider_thread_id = 't5'`,
    )
    thread.t5 = t5!.id
    expect((await row('t5')).reminder).toEqual({ at, condition: 'if_no_reply' })

    await acceptSend(db, USER, req(uuid(21)))
    expect(await cancelSend(db, USER, uuid(21))).toBe(true)
    expect(await db.query(`SELECT 1 FROM reminders WHERE op_id = $1`, [uuid(21)])).toEqual([])
  })
})
