import {
  acceptOps,
  acceptSend,
  cancelSend,
  readDelta,
  readOpStatuses,
  saveCredentials,
  type Db,
} from '@zachmail/db/server'
import { USER, createTestDb, type TestDb } from '@zachmail/db/testing'
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ProviderFactory,
  createHandlers,
  enqueueInitialSync,
  enqueueOutboxFlush,
  getMessageBody,
  type EngineConfig,
  type JobLike,
} from '../src'

const KEY = randomBytes(32).toString('base64')
const config: EngineConfig = {
  google: { clientId: 'cid', clientSecret: 'secret', pubsubTopic: 'projects/p/topics/gmail' },
  imageProxySecret: 'img-secret',
  appOrigin: 'https://mail.example.com',
  tokenKey: KEY,
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')
const gmailMsg = (id: string, threadId: string, labels: string[], date: number) => ({
  id,
  threadId,
  labelIds: labels,
  snippet: `snippet ${id}`,
  internalDate: String(date),
  payload: {
    headers: [
      { name: 'From', value: 'Ana <ana@x.com>' },
      { name: 'Subject', value: `About ${threadId}` },
      { name: 'Message-ID', value: `<${id}@x.com>` },
    ],
  },
})

/** Fake Google: token endpoint plus the Gmail calls a sync makes. */
function fakeGoogle() {
  const state = {
    history: [] as unknown[],
    historyId: '100',
    refreshes: 0,
    watchCalls: 0,
    writes: [] as string[],
    failWrites: 0,
    sent: [] as { raw: string; threadId?: string }[],
  }
  const now = Date.now()
  const threads: Record<string, ReturnType<typeof gmailMsg>[]> = {
    t1: [gmailMsg('m1', 't1', ['INBOX', 'UNREAD'], now - 3_600_000)],
    t2: [
      gmailMsg('m2', 't2', ['INBOX'], now - 7_200_000),
      gmailMsg('m3', 't2', ['SENT'], now - 7_100_000),
    ],
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    if (url.host === 'oauth2.googleapis.com') {
      state.refreshes++
      return json({ access_token: 'at', expires_in: 3600 })
    }
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    if (path === '/profile') return json({ emailAddress: 'zach@x.com', historyId: state.historyId })
    if (path === '/labels')
      return json({
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'SENT', name: 'SENT', type: 'system' },
        ],
      })
    if (path === '/threads') {
      if (url.searchParams.get('q')?.includes('older_than')) return json({})
      return url.searchParams.get('pageToken')
        ? json({ threads: [{ id: 't2' }] })
        : json({ threads: [{ id: 't1' }], nextPageToken: 'p2' })
    }
    if (path === '/messages/send') {
      const body = JSON.parse(String(init?.body)) as { raw: string; threadId?: string }
      state.sent.push({
        raw: Buffer.from(body.raw, 'base64url').toString(),
        threadId: body.threadId,
      })
      return json({ id: 'sent1', threadId: body.threadId ?? 'tnew' })
    }
    const w = path.match(/^\/threads\/(\w+)\/(modify|trash|untrash)$/)
    if (w) {
      if (state.failWrites) return json({ error: { code: state.failWrites } }, state.failWrites)
      state.writes.push(`${w[2]} ${w[1]} ${init?.body ?? ''}`)
      return json({ id: w[1] })
    }
    const t = path.match(/^\/threads\/(\w+)$/)
    if (t) return json({ id: t[1], messages: threads[t[1]!] })
    if (path === '/history') return json({ historyId: '200', history: state.history })
    if (path === '/messages/m4' && url.searchParams.get('format') === 'metadata')
      return json(gmailMsg('m4', 't1', ['INBOX', 'UNREAD'], now))
    if (path === '/messages/m5' && url.searchParams.get('format') === 'metadata')
      return json(gmailMsg('m5', 't1', ['INBOX', 'UNREAD'], now + 1000))
    const full = path.match(/^\/messages\/(\w+)$/)
    if (full && url.searchParams.get('format') === 'full')
      return json({
        id: full[1],
        threadId: 't',
        payload: {
          mimeType: 'text/html',
          body: { data: b64('<p>Hello<img src="https://t.example/p.gif"></p>') },
        },
      })
    if (path === '/watch') {
      state.watchCalls++
      return json({ historyId: '150', expiration: String(now + 7 * 86_400_000) })
    }
    return json({ error: path }, 404)
  }
  return { fetchImpl, state }
}

let t: TestDb
let db: Db
let accountId: string
let google: ReturnType<typeof fakeGoogle>
let handlers: ReturnType<typeof createHandlers>
let providers: ProviderFactory

/** Claims and runs queued jobs until the queue holds nothing ready. */
async function drain(max = 50) {
  const ran: string[] = []
  for (let i = 0; i < max; i++) {
    const [job] = await db.query<JobLike & { id: number }>(
      `SELECT id::int, kind, user_id AS "userId", payload FROM claim_jobs('test', 1)`,
    )
    if (!job) break
    await handlers[job.kind]!(job)
    await db.query(`DELETE FROM jobs WHERE id = $1`, [job.id])
    ran.push(job.kind)
  }
  return ran
}

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  google = fakeGoogle()
  providers = new ProviderFactory(db, config, google.fetchImpl as never)
  handlers = createHandlers({ db, providers, config })
  const [a] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email) VALUES ($1, 'gmail', 'zach@x.com') RETURNING id`,
    [USER],
  )
  accountId = a!.id
  await saveCredentials(db, await providers.encryptionKey(), {
    accountId,
    userId: USER,
    secret: { refreshToken: 'rt' },
  })
})

afterAll(() => t.close())

describe('engine', () => {
  it('backfills, activates the account, watches and prefetches inbox bodies', async () => {
    await enqueueInitialSync(db, USER, accountId)
    // The older-window backfill is scheduled a minute out; pull it forward for the test.
    let ran = await drain()
    await db.query(
      `UPDATE jobs SET run_at = now() WHERE locked_by IS NULL AND kind = 'mail.backfill'`,
    )
    ran = ran.concat(await drain())

    expect(ran.filter((k) => k === 'mail.backfill')).toHaveLength(3)
    expect(ran).toContain('gmail.watch')
    expect(ran).toContain('bodies.prefetch')

    const delta = await readDelta(db, USER, 0)
    expect(delta.upserts.threads.map((t) => t.subject).sort()).toEqual(['About t1', 'About t2'])
    expect(delta.upserts.accounts[0]).toMatchObject({ status: 'active' })
    const inboxBodies = delta.upserts.messages.filter((m) => m.bodyStatus === 'cached')
    expect(inboxBodies.length).toBeGreaterThanOrEqual(2)
    expect(google.state.watchCalls).toBe(1)
    expect(google.state.refreshes).toBe(1) // access token cached across calls

    const [{ n }] = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE kind = 'gmail.watch' AND run_at > now() + interval '23 hours'`,
    )) as [{ n: number }]
    expect(n).toBe(1)
  })

  it('applies pushed history incrementally', async () => {
    google.state.history = [{ id: '190', messagesAdded: [{ message: { id: 'm4' } }] }]
    const before = (await readDelta(db, USER, 0)).seq
    await handlers['account.sync']!({ kind: 'account.sync', userId: USER, payload: { accountId } })
    const delta = await readDelta(db, USER, before)
    expect(delta.upserts.messages.map((m) => m.snippet)).toContain('snippet m4')
    expect(delta.upserts.threads[0]).toMatchObject({
      subject: 'About t1',
      messageCount: 2,
      unread: true,
    })
    const [acct] = await db.query<{ h: string }>(
      `SELECT sync_state->>'historyId' AS h FROM accounts WHERE id = $1`,
      [accountId],
    )
    expect(acct!.h).toBe('200')
  })

  it('serves cached sanitized bodies with images parked behind the proxy', async () => {
    const [m] = await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE provider_message_id = 'm1'`,
    )
    const r = await getMessageBody(db, providers, config.imageProxySecret, USER, m!.id)
    expect(r!.fetched).toBe(false)
    expect(r!.body.hasRemoteImages).toBe(true)
    expect(r!.body.html).toContain('data-zm-src="/api/img?u=https%3A%2F%2Ft.example%2Fp.gif&amp;s=')
  })

  it('applies triage ops at Gmail in order and reconciles with a sync', async () => {
    const [t1] = await db.query<{ id: string }>(
      `SELECT id FROM threads WHERE provider_thread_id = 't1'`,
    )
    const op = (n: number, kind: 'archive' | 'inbox' | 'read') => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      at: n,
      op: { kind, threadIds: [t1!.id] },
    })
    const r = await acceptOps(db, USER, [op(1, 'archive'), op(2, 'inbox'), op(3, 'read')])
    expect(r.accounts).toEqual([accountId])
    await enqueueOutboxFlush(db, USER, accountId)
    const ran = await drain()
    expect(ran.filter((k) => k !== 'bodies.prefetch')).toEqual(['outbox.flush', 'account.sync'])
    expect(google.state.writes).toEqual([
      'modify t1 {"addLabelIds":[],"removeLabelIds":["INBOX"]}',
      'modify t1 {"addLabelIds":["INBOX"],"removeLabelIds":[]}',
      'modify t1 {"addLabelIds":[],"removeLabelIds":["UNREAD"]}',
    ])
    const ops = await readOpStatuses(db, USER, [op(1, 'read').id, op(3, 'read').id])
    expect(ops.map((o) => o.state)).toEqual(['done', 'done'])
  })

  it('retries transient failures, then restores Gmail state on a permanent one', async () => {
    const [t2] = await db.query<{ id: string }>(
      `SELECT id FROM threads WHERE provider_thread_id = 't2'`,
    )
    const id = '00000000-0000-4000-8000-000000000009'
    await acceptOps(db, USER, [{ id, at: 9, op: { kind: 'archive', threadIds: [t2!.id] } }])
    const inInbox = async () =>
      (
        await db.query(
          `SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
           WHERE tf.thread_id = $1 AND f.kind = 'inbox'`,
          [t2!.id],
        )
      ).length > 0
    expect(await inInbox()).toBe(false)

    const flush = () =>
      handlers['outbox.flush']!({ kind: 'outbox.flush', userId: USER, payload: { accountId } })
    google.state.failWrites = 503
    // Fail fast instead of backing off inside the Gmail client.
    const fast = new ProviderFactory(db, config, google.fetchImpl as never, { maxRetries: 0 })
    const h = createHandlers({ db, providers: fast, config })
    await h['outbox.flush']!({ kind: 'outbox.flush', userId: USER, payload: { accountId } })
    const [row] = await db.query<{ state: string; attempts: number }>(
      `SELECT state, attempts FROM outbox WHERE op_id = $1`,
      [id],
    )
    expect(row).toMatchObject({ state: 'pending', attempts: 1 })

    google.state.failWrites = 400
    await db.query(`UPDATE outbox SET not_before = now() WHERE op_id = $1`, [id])
    await flush()
    const [status] = await readOpStatuses(db, USER, [id])
    expect(status).toMatchObject({ state: 'failed' })
    expect(status!.error).toContain('400')
    expect(await inInbox()).toBe(true)
    google.state.failWrites = 0
  })

  it('sends replies after the undo window, threaded, and lets pending sends be undone', async () => {
    const [m1] = await db.query<{ id: string }>(
      `SELECT id FROM messages WHERE provider_message_id = 'm1'`,
    )
    const base = {
      accountId,
      to: [{ email: 'ana@x.com', name: 'Ana' }],
      bcc: [{ email: 'me@x.com' }],
      subject: 'Re: About t1',
      html: '<p>Sounds good</p>',
      replyToMessageId: m1!.id,
    }
    const now = '00000000-0000-4000-8000-0000000000e1'
    const later = '00000000-0000-4000-8000-0000000000e2'
    await acceptSend(db, USER, { ...base, id: now, undoMs: 0 })
    const at = await acceptSend(db, USER, { ...base, id: later, undoMs: 10_000 })
    expect(at).toBeGreaterThan(Date.now() + 5_000)

    await handlers['outbox.flush']!({ kind: 'outbox.flush', userId: USER, payload: { accountId } })
    expect(google.state.sent).toHaveLength(1)
    const { raw, threadId } = google.state.sent[0]!
    expect(threadId).toBe('t1')
    expect(raw).toContain('To: Ana <ana@x.com>')
    expect(raw).toContain('Bcc: me@x.com')
    expect(raw).toContain(`Message-ID: <${now}@x.com>`)
    expect(raw).toContain('In-Reply-To: <m1@x.com>')
    expect(raw).toContain('References: <m1@x.com>')
    expect((await readOpStatuses(db, USER, [now]))[0]!.state).toBe('done')

    expect(await cancelSend(db, USER, later)).toBe(true)
    expect(await cancelSend(db, USER, now)).toBe(false)
  })

  it('snoozes at Gmail and brings the thread back unread when the wake job runs', async () => {
    const [t2] = await db.query<{ id: string }>(
      `SELECT id FROM threads WHERE provider_thread_id = 't2'`,
    )
    const id = '00000000-0000-4000-8000-0000000000f1'
    google.state.history = [] // the fake doesn't reflect writes; later syncs see no news
    await acceptOps(db, USER, [
      { id, at: 1, op: { kind: 'snooze', threadIds: [t2!.id], until: Date.now() + 3_600_000 } },
    ])
    google.state.writes = []
    await handlers['outbox.flush']!({ kind: 'outbox.flush', userId: USER, payload: { accountId } })
    expect(google.state.writes).toEqual(['modify t2 {"addLabelIds":[],"removeLabelIds":["INBOX"]}'])

    await db.query(`UPDATE threads SET snoozed_until = now() WHERE id = $1`, [t2!.id])
    await handlers['snooze.wake']!({ kind: 'snooze.wake', userId: USER, payload: {} })
    await drain()
    expect(google.state.writes.at(-1)).toBe(
      'modify t2 {"addLabelIds":["INBOX","UNREAD"],"removeLabelIds":[]}',
    )
    const delta = await readDelta(db, USER, 0)
    expect(delta.upserts.threads.find((x) => x.id === t2!.id)).toMatchObject({
      unread: true,
      snoozedUntil: null,
    })
  })

  it('keeps muted threads out of the inbox when replies arrive', async () => {
    const [t1] = await db.query<{ id: string }>(
      `SELECT id FROM threads WHERE provider_thread_id = 't1'`,
    )
    await acceptOps(db, USER, [
      {
        id: '00000000-0000-4000-8000-0000000000d1',
        at: 1,
        op: { kind: 'mute', threadIds: [t1!.id] },
      },
    ])
    await enqueueOutboxFlush(db, USER, accountId)
    await drain()
    google.state.writes = []

    google.state.history = [{ id: '300', messagesAdded: [{ message: { id: 'm5' } }] }]
    await handlers['account.sync']!({ kind: 'account.sync', userId: USER, payload: { accountId } })
    google.state.history = [] // the fake doesn't reflect writes; later syncs see no news
    const inInbox = await db.query(
      `SELECT 1 FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
       WHERE tf.thread_id = $1 AND f.kind = 'inbox'`,
      [t1!.id],
    )
    expect(inInbox).toEqual([])
    await drain()
    expect(google.state.writes).toEqual(['modify t1 {"addLabelIds":[],"removeLabelIds":["INBOX"]}'])
    const delta = await readDelta(db, USER, 0)
    expect(delta.upserts.threads.find((t) => t.id === t1!.id)).toMatchObject({ muted: true })
  })

  it('parks the account when the refresh token is revoked', async () => {
    const revoked = new ProviderFactory(
      db,
      config,
      (async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as never,
    )
    const h = createHandlers({ db, providers: revoked, config })
    await h['account.sync']!({ kind: 'account.sync', userId: USER, payload: { accountId } })
    const [a] = await db.query<{ status: string }>(`SELECT status FROM accounts WHERE id = $1`, [
      accountId,
    ])
    expect(a!.status).toBe('needs_reauth')
  })
})
