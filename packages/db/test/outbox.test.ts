import type { ProviderMessage } from '@zachmail/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acceptOps,
  applySyncBatch,
  claimOutbox,
  finishOutbox,
  readDelta,
  releaseOutbox,
  stalledOutboxAccounts,
  type Db,
} from '../src/server'
import { USER, createTestDb, type TestDb } from './helpers'

let t: TestDb
let db: Db
let accountId: string
const thread: Record<string, string> = {}
const folder: Record<string, string> = {}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const msg = (id: string, threadId: string, labels: string[], unread = false): ProviderMessage => ({
  providerMessageId: id,
  providerThreadId: threadId,
  rfc822MessageId: null,
  inReplyTo: null,
  references: [],
  from: { email: 'ana@x.com' },
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: 's',
  snippet: '',
  date: new Date('2026-10-12T10:00:00Z'),
  folderIds: labels,
  unread,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  size: 1,
  attachments: [],
})

const folderRow = (providerId: string, kind: 'inbox' | 'trash' | 'starred' | 'custom') => ({
  providerId,
  name: providerId,
  kind,
  unreadCount: 0,
  totalCount: 0,
})

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@x.com') RETURNING id`,
    [USER],
  )
  accountId = a!.id
  await applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: {
      folders: [
        folderRow('INBOX', 'inbox'),
        folderRow('TRASH', 'trash'),
        folderRow('STARRED', 'starred'),
        folderRow('Label_1', 'custom'),
      ],
      messages: [
        msg('m1', 't1', ['INBOX'], true),
        msg('m2', 't1', ['INBOX', 'SENT']),
        msg('m3', 't2', ['INBOX']),
      ],
      deletedMessageIds: [],
    },
  })
  for (const r of await db.query<{ id: string; provider_thread_id: string }>(
    `SELECT id, provider_thread_id FROM threads`,
  ))
    thread[r.provider_thread_id] = r.id
  for (const r of await db.query<{ id: string; provider_id: string }>(
    `SELECT id, provider_id FROM folders`,
  ))
    folder[r.provider_id] = r.id
})

afterAll(() => t.close())

const labelsOf = async (threadKey: string) =>
  (
    await db.query<{ provider_labels: string[] }>(
      `SELECT provider_labels FROM messages WHERE thread_id = $1 ORDER BY provider_message_id`,
      [thread[threadKey]],
    )
  ).map((r) => [...r.provider_labels].sort())

const maxSeq = async () =>
  (await db.query<{ s: number }>(`SELECT COALESCE(max(seq), 0)::float8 AS s FROM changes`))[0]!.s

describe('outbox', () => {
  it('mirrors an op, logs changes and queues one row', async () => {
    const since = await maxSeq()
    const r = await acceptOps(db, USER, [
      { id: uuid(1), at: 1, op: { kind: 'archive', threadIds: [thread.t1!] } },
    ])
    expect(r).toEqual({ accepted: [uuid(1)], rejected: [], accounts: [accountId] })
    expect(await labelsOf('t1')).toEqual([[], ['SENT']])

    const delta = await readDelta(db, USER, since)
    expect(delta.upserts.threads.map((x) => x.id)).toEqual([thread.t1])
    expect(delta.upserts.threads[0]!.folderIds).not.toContain(folder.INBOX)
    expect(delta.upserts.messages).toHaveLength(2)
    expect(delta.ops).toEqual([{ id: uuid(1), state: 'pending', error: null }])
  })

  it('accepts a replayed op id without applying it twice', async () => {
    await acceptOps(db, USER, [
      { id: uuid(2), at: 2, op: { kind: 'inbox', threadIds: [thread.t1!] } },
    ])
    const again = await acceptOps(db, USER, [
      { id: uuid(2), at: 2, op: { kind: 'inbox', threadIds: [thread.t1!] } },
    ])
    expect(again).toEqual({ accepted: [uuid(2)], rejected: [], accounts: [] })
    const [{ n }] = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE op_id = $1`,
      [uuid(2)],
    )) as [{ n: number }]
    expect(n).toBe(1)
  })

  it('sets flags and labels, ignoring folders of other accounts', async () => {
    await acceptOps(db, USER, [
      { id: uuid(3), at: 3, op: { kind: 'read', threadIds: [thread.t1!] } },
      { id: uuid(4), at: 3, op: { kind: 'star', threadIds: [thread.t2!] } },
      {
        id: uuid(5),
        at: 3,
        op: {
          kind: 'label',
          threadIds: [thread.t2!],
          add: [folder.Label_1!, uuid(99)],
          remove: [],
        },
      },
    ])
    const [t1] = await db.query<{ unread: boolean }>(`SELECT unread FROM threads WHERE id = $1`, [
      thread.t1,
    ])
    expect(t1!.unread).toBe(false)
    expect(await labelsOf('t2')).toEqual([['INBOX', 'Label_1', 'STARRED']])
    const [row] = await db.query<{ payload: { add: string[] } }>(
      `SELECT payload FROM outbox WHERE op_id = $1`,
      [uuid(5)],
    )
    expect(row!.payload.add).toEqual([folder.Label_1])
  })

  it('rejects ops on unknown threads', async () => {
    const r = await acceptOps(db, USER, [
      { id: uuid(6), at: 4, op: { kind: 'read', threadIds: [uuid(77)] } },
    ])
    expect(r.rejected).toHaveLength(1)
  })

  it('claims rows one at a time in order and reports status', async () => {
    const first = await claimOutbox(db, accountId)
    expect(first).toMatchObject({ opId: uuid(1), kind: 'archive', attempts: 1 })
    // The next op waits until the first is finished.
    expect(await claimOutbox(db, accountId)).toBeNull()

    const since = await maxSeq()
    await finishOutbox(db, first!, { state: 'done' })
    expect((await readDelta(db, USER, since)).ops).toEqual([
      { id: uuid(1), state: 'done', error: null },
    ])

    const second = await claimOutbox(db, accountId)
    expect(second?.opId).toBe(uuid(2))
    await finishOutbox(db, second!, {
      state: 'retry',
      error: 'busy',
      at: new Date(Date.now() + 60_000),
    })
    // A retrying op still holds the line.
    expect(await claimOutbox(db, accountId)).toBeNull()
    await db.query(`UPDATE outbox SET not_before = now() WHERE op_id = $1`, [uuid(2)])
    const retried = await claimOutbox(db, accountId)
    expect(retried).toMatchObject({ opId: uuid(2), attempts: 2 })
    await releaseOutbox(db, retried!)
    const again = await claimOutbox(db, accountId)
    expect(again).toMatchObject({ opId: uuid(2), attempts: 2 })

    const s2 = await maxSeq()
    await finishOutbox(db, again!, { state: 'failed', error: 'Gmail said no' })
    expect((await readDelta(db, USER, s2)).ops).toEqual([
      { id: uuid(2), state: 'failed', error: 'Gmail said no' },
    ])
  })

  it('lets sends wait without blocking triage, and finds stalled accounts', async () => {
    await db.query(
      `INSERT INTO outbox (user_id, op_id, account_id, kind, not_before)
       VALUES ($1, $2, $3, 'send', now() + interval '10 seconds')`,
      [USER, uuid(10), accountId],
    )
    await acceptOps(db, USER, [
      { id: uuid(11), at: 5, op: { kind: 'unread', threadIds: [thread.t2!] } },
    ])
    const claimed: string[] = []
    for (
      let item = await claimOutbox(db, accountId);
      item;
      item = await claimOutbox(db, accountId)
    ) {
      claimed.push(item.opId)
      await finishOutbox(db, item, { state: 'done' })
    }
    expect(claimed).toEqual([uuid(3), uuid(4), uuid(5), uuid(11)])

    expect(await stalledOutboxAccounts(db)).toEqual([])
    await db.query(`UPDATE outbox SET not_before = now() - interval '1 minute' WHERE op_id = $1`, [
      uuid(10),
    ])
    expect(await stalledOutboxAccounts(db)).toEqual([{ userId: USER, accountId }])
  })
})
