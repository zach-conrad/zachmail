import { createAi } from '@zachmail/ai'
import { FAKE_ANTHROPIC_URL, fakeAnthropic, type FakeReply } from '@zachmail/ai/testing'
import { applySyncBatch, readDelta, type Db } from '@zachmail/db/server'
import { USER, createTestDb, type TestDb } from '@zachmail/db/testing'
import type { ProviderMessage } from '@zachmail/providers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AI_TRIAGE_JOB,
  ProviderFactory,
  createHandlers,
  enqueueTriage,
  type EngineConfig,
} from '../src'

const config: EngineConfig = {
  google: { clientId: 'cid', clientSecret: 'secret' },
  imageProxySecret: 'img-secret',
  appOrigin: 'https://mail.example.com',
}

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
  unread: true,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  size: 100,
  attachments: [],
  ...over,
})
const FOLDERS = [
  { providerId: 'INBOX', name: 'INBOX', kind: 'inbox' as const, unreadCount: 0, totalCount: 0 },
  { providerId: 'SENT', name: 'SENT', kind: 'sent' as const, unreadCount: 0, totalCount: 0 },
]

let t: TestDb
let db: Db
let accountId: string
let reply: (body: Record<string, unknown>) => FakeReply
const fake = fakeAnthropic((b) => reply(b))
const ai = createAi({ apiKey: 'k', baseURL: FAKE_ANTHROPIC_URL, fetch: fake.fetch })

const apply = (messages: ProviderMessage[]) =>
  applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: { folders: FOLDERS, messages, deletedMessageIds: [] },
  })
const triage = (handlers: ReturnType<typeof createHandlers>) =>
  handlers[AI_TRIAGE_JOB]!({ kind: AI_TRIAGE_JOB, userId: USER, payload: { accountId } })
const aiRows = () =>
  db.query<{ provider_thread_id: string; ai_category: string | null; triaged: boolean }>(
    `SELECT provider_thread_id, ai_category, ai_triaged_at IS NOT NULL AS triaged
     FROM threads ORDER BY provider_thread_id`,
  )

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email, send_as) VALUES ($1, 'gmail', 'zach@x.com', $2::jsonb) RETURNING id`,
    [USER, [{ email: 'z@alias.com' }]],
  )
  accountId = a!.id
})
afterAll(() => t.close())

describe('triage', () => {
  const handlers = () =>
    createHandlers({ db, providers: new ProviderFactory(db, config), config, ai })

  it('triages inbox threads and syncs the result to clients', async () => {
    await apply([
      msg('m1', 't1'),
      msg('m2', 't2', { from: { email: 'news@shop.com' }, listUnsubscribe: '<mailto:u@shop.com>' }),
      msg('m3', 't3', { folderIds: ['SENT'], from: { email: 'zach@x.com' } }),
    ])
    await db.query(
      `INSERT INTO message_bodies (message_id, user_id, html, text)
       SELECT id, user_id, '<p>x</p>', 'Can we meet Friday at noon?' FROM messages WHERE provider_message_id = 'm1'`,
    )
    reply = (b) => {
      const prompt = JSON.stringify(b.messages)
      return {
        text: JSON.stringify(
          prompt.includes('news@shop.com')
            ? { category: 'newsletter', summary: 'Fall sale.', needs_reply: false }
            : { category: 'important', summary: 'Ana asks to meet Friday.', needs_reply: true },
        ),
      }
    }
    const before = (await readDelta(db, USER, 0)).seq
    await triage(handlers())

    expect(fake.requests).toHaveLength(2) // the sent-only thread is not in the inbox
    const prompts = fake.requests.map((r) => JSON.stringify(r.body.messages)).join()
    expect(prompts).toContain('Can we meet Friday at noon?') // cached body beats the snippet
    expect(prompts).toContain('z@alias.com') // send-as aliases count as Zach
    const delta = await readDelta(db, USER, before)
    const bySubject = Object.fromEntries(delta.upserts.threads.map((th) => [th.subject, th.ai]))
    expect(bySubject).toEqual({
      'Subject t1': {
        category: 'important',
        summary: 'Ana asks to meet Friday.',
        needsReply: true,
      },
      'Subject t2': { category: 'newsletter', summary: 'Fall sale.', needsReply: false },
    })
  })

  it('skips triaged threads until new mail arrives', async () => {
    fake.requests.length = 0
    await triage(handlers())
    expect(fake.requests).toHaveLength(0)

    await apply([
      msg('m4', 't1', { date: new Date('2026-10-13T10:00:00Z'), snippet: 'Never mind, Monday?' }),
    ])
    await triage(handlers())
    expect(fake.requests).toHaveLength(1)
    expect(JSON.stringify(fake.requests[0]!.body.messages)).toContain('Never mind, Monday?')
  })

  it('marks declined threads done without a result, and retries API failures', async () => {
    await apply([msg('m5', 't5'), msg('m6', 't6')])
    reply = () => ({ status: 500 })
    await expect(triage(handlers())).rejects.toThrow()
    expect((await aiRows()).find((r) => r.provider_thread_id === 't5')?.triaged).toBe(false)

    fake.requests.length = 0
    reply = () => ({ text: '', stopReason: 'refusal' })
    await triage(handlers())
    const rows = await aiRows()
    expect(rows.find((r) => r.provider_thread_id === 't5')).toMatchObject({
      triaged: true,
      ai_category: null,
    })
    await triage(handlers())
    expect(fake.requests).toHaveLength(2) // not asked again
  })

  it('is a no-op while AI is off', async () => {
    await apply([msg('m7', 't7')])
    fake.requests.length = 0
    await enqueueTriage(db, USER, accountId)
    await triage(createHandlers({ db, providers: new ProviderFactory(db, config), config }))
    expect(fake.requests).toHaveLength(0)
  })
})
