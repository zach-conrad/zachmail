import { createAi } from '@zachhub/ai'
import { FAKE_ANTHROPIC_URL, fakeAnthropic, type FakeReply } from '@zachhub/ai/testing'
import { readAssistStream } from '@zachhub/core'
import { applySyncBatch, saveCredentials, type Db } from '@zachhub/db/server'
import { USER, createTestDb, type TestDb } from '@zachhub/db/testing'
import { graphClientState, proxiedImageUrl } from '@zachhub/engine'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type CryptoKey } from 'jose'
import { randomBytes } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app'
import type { Env } from './env'

const SUPABASE_URL = 'https://example.supabase.co'
const env: Env = {
  SUPABASE_URL,
  ALLOWED_EMAILS: 'zach@example.com',
  GIT_SHA: 'abc123',
  APP_ORIGIN: 'https://mail.example.com',
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  GMAIL_PUSH_AUDIENCE: 'https://mail.example.com/webhooks/gmail',
  GMAIL_PUSH_SERVICE_ACCOUNT: 'push@proj.iam.gserviceaccount.com',
  OAUTH_STATE_SECRET: 'state-secret',
  IMAGE_PROXY_SECRET: 'img-secret',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  VAPID_PUBLIC_KEY: 'BPublicKey',
  MICROSOFT_CLIENT_ID: 'ms-cid',
  MICROSOFT_CLIENT_SECRET: 'ms-secret',
  GRAPH_WEBHOOK_SECRET: 'graph-secret',
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')

/** Fake Google + one fake remote image host. */
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  if (url.host === 'oauth2.googleapis.com') {
    const params = new URLSearchParams(String(init?.body))
    if (params.get('grant_type') === 'authorization_code') {
      return params.get('code') === 'good-code' && params.get('code_verifier')
        ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email' })
        : json({ error: 'invalid_grant' }, 400)
    }
    return json({ access_token: 'at2', expires_in: 3600 })
  }
  if (url.host === 'login.microsoftonline.com') {
    const params = new URLSearchParams(String(init?.body))
    return params.get('code') === 'ms-code' && params.get('code_verifier')
      ? json({
          access_token: 'mat',
          refresh_token: 'mrt',
          expires_in: 3600,
          scope: 'Mail.ReadWrite',
        })
      : json({ error: 'invalid_grant' }, 400)
  }
  if (url.host === 'graph.microsoft.com' && url.pathname === '/v1.0/me')
    return json({ mail: null, userPrincipalName: 'Zach@ZachConrad.dev', displayName: 'Zach' })
  if (url.pathname.endsWith('/profile'))
    return json({ emailAddress: 'Zach@Gmail.com', historyId: '1' })
  if (url.pathname.includes('/messages/pm1'))
    return json({
      id: 'pm1',
      threadId: 'pt1',
      payload: { mimeType: 'text/plain', body: { data: b64('hi <there>') } },
    })
  if (url.pathname.startsWith('/storage/v1/object/upload/sign/'))
    return json({ url: `${url.pathname.replace('/storage/v1', '')}?token=t` })
  if (url.host === '93.184.216.34')
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  return json({}, 404)
}

let t: TestDb
let db: Db
let app: ReturnType<typeof createApp>
let userToken: string
let overrides: Parameters<typeof createApp>[1]
let signGoogle: (claims: Record<string, unknown>, aud?: string) => Promise<string>

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const supa = await generateKeyPair('ES256')
  const goog = await generateKeyPair('RS256')
  const jwks = async (k: CryptoKey, kid: string, alg: string) => ({
    ...(await exportJWK(k)),
    kid,
    alg,
  })
  overrides = {
    db: () => db,
    fetch: fakeFetch as never,
    supabaseKeys: createLocalJWKSet({ keys: [await jwks(supa.publicKey, 's1', 'ES256')] }),
    googleKeys: createLocalJWKSet({ keys: [await jwks(goog.publicKey, 'g1', 'RS256')] }),
  }
  app = createApp(env, overrides)
  userToken = await new SignJWT({ email: 'zach@example.com' })
    .setProtectedHeader({ alg: 'ES256', kid: 's1' })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setSubject(USER)
    .setExpirationTime('5m')
    .sign(supa.privateKey)
  signGoogle = (claims, aud = env.GMAIL_PUSH_AUDIENCE!) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'g1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(aud)
      .setExpirationTime('5m')
      .sign(goog.privateKey)
})
afterAll(() => t.close())

const authed = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { authorization: `Bearer ${userToken}`, ...init.headers } })

const jobCount = async (kind: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE kind = $1`, [kind]))[0]!
    .n

describe('auth', () => {
  it('serves health without auth and rejects anonymous API calls', async () => {
    expect(await (await app.request('/api/health')).json()).toEqual({ ok: true, sha: 'abc123' })
    expect((await app.request('/api/me')).status).toBe(401)
    expect((await app.request('/api/sync')).status).toBe(401)
    expect((await authed('/api/me')).status).toBe(200)
  })
})

describe('gmail connect', () => {
  async function start() {
    const res = await authed('/api/accounts/connect/gmail', { method: 'POST' })
    const { url } = (await res.json()) as { url: string }
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    return { url: new URL(url), cookie }
  }

  it('returns a PKCE Google URL and completes the callback into an account + first sync', async () => {
    const { url, cookie } = await start()
    expect(url.host).toBe('accounts.google.com')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://mail.example.com/api/accounts/callback/gmail',
    )

    const res = await app.request(
      `/api/accounts/callback/gmail?code=good-code&state=${url.searchParams.get('state')}`,
      { headers: { cookie } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/?connected=Zach%40Gmail.com')
    const [acct] = await db.query<{ email: string; status: string }>(
      `SELECT email, status FROM accounts`,
    )
    expect(acct).toEqual({ email: 'zach@gmail.com', status: 'connecting' })
    expect(await jobCount('mail.backfill')).toBe(1)
  })

  it('rejects a callback whose cookie does not match the state', async () => {
    const { url } = await start()
    const res = await app.request(
      `/api/accounts/callback/gmail?code=good-code&state=${url.searchParams.get('state')}`,
      {
        headers: { cookie: 'zm_oauth=wrong.verifier' },
      },
    )
    expect(res.headers.get('location')).toBe('/?connect_error=state_mismatch')
  })
})

describe('gmail webhook', () => {
  const push = async (token: string, email = 'zach@gmail.com') =>
    app.request('/webhooks/gmail', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          data: Buffer.from(JSON.stringify({ emailAddress: email, historyId: 5 })).toString(
            'base64',
          ),
        },
      }),
    })

  it('verifies the Pub/Sub token and enqueues one coalesced sync', async () => {
    const good = await signGoogle({ email: env.GMAIL_PUSH_SERVICE_ACCOUNT, email_verified: true })
    expect((await push(good)).status).toBe(204)
    expect((await push(good)).status).toBe(204)
    expect(await jobCount('account.sync')).toBe(1)
  })

  it('rejects wrong audiences and service accounts', async () => {
    expect(
      (
        await push(
          await signGoogle(
            { email: env.GMAIL_PUSH_SERVICE_ACCOUNT, email_verified: true },
            'other',
          ),
        )
      ).status,
    ).toBe(401)
    expect(
      (await push(await signGoogle({ email: 'evil@x.com', email_verified: true }))).status,
    ).toBe(403)
    expect((await push('garbage')).status).toBe(401)
  })
})

describe('sync endpoints', () => {
  let messageId: string

  beforeAll(async () => {
    const [acct] = await db.query<{ id: string }>(`SELECT id FROM accounts LIMIT 1`)
    await saveCredentials(db, Buffer.from(env.TOKEN_ENCRYPTION_KEY!, 'base64'), {
      accountId: acct!.id,
      userId: USER,
      secret: { refreshToken: 'rt' },
    })
    await applySyncBatch(db, {
      userId: USER,
      accountId: acct!.id,
      batch: {
        folders: [
          { providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0, totalCount: 0 },
        ],
        deletedMessageIds: [],
        messages: [
          {
            providerMessageId: 'pm1',
            providerThreadId: 'pt1',
            rfc822MessageId: null,
            inReplyTo: null,
            references: [],
            from: { email: 'ana@x.com' },
            to: [],
            cc: [],
            bcc: [],
            replyTo: [],
            subject: 'Hello',
            snippet: 'hi',
            date: new Date(),
            folderIds: ['INBOX'],
            unread: true,
            starred: false,
            hasAttachments: false,
            listUnsubscribe: null,
            size: 1,
            attachments: [],
          },
        ],
      },
    })
    messageId = (await db.query<{ id: string }>(`SELECT id FROM messages LIMIT 1`))[0]!.id
  })

  it('accepts triage ops idempotently and queues one outbox flush', async () => {
    const threadId = (await db.query<{ id: string }>(`SELECT id FROM threads LIMIT 1`))[0]!.id
    const id = '00000000-0000-4000-8000-0000000000f1'
    const post = (body: unknown) =>
      authed('/api/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const body = { ops: [{ id, at: Date.now(), op: { kind: 'read', threadIds: [threadId] } }] }
    const res = await post(body)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: [id], rejected: [] })
    expect(await (await post(body)).json()).toEqual({ accepted: [id], rejected: [] })
    expect(await jobCount('outbox.flush')).toBe(1)
    const [thread] = await db.query<{ unread: boolean }>(
      `SELECT unread FROM threads WHERE id = $1`,
      [threadId],
    )
    expect(thread!.unread).toBe(false)

    expect((await post({ ops: [{ id: 'nope' }] })).status).toBe(400)
    const anon = await app.request('/api/ops', { method: 'POST', body: JSON.stringify(body) })
    expect(anon.status).toBe(401)
  })

  it('saves and deletes split rules, queueing one re-split', async () => {
    const id = '00000000-0000-4000-8000-0000000000f3'
    const put = (body: unknown, ruleId = id) =>
      authed(`/api/split-rules/${ruleId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const rule = {
      name: 'Receipts',
      target: 'custom',
      match: 'any',
      conditions: [{ field: 'domain', value: 'stripe.com' }],
      position: 1,
    }
    const res = await put(rule)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id, ...rule })
    expect((await put({ ...rule, name: 'Stripe' })).status).toBe(200)
    expect(await jobCount('splits.recompute')).toBe(1)
    expect(await (await authed('/api/split-rules')).json()).toEqual([
      { id, ...rule, name: 'Stripe' },
    ])

    expect((await put({ ...rule, target: 'nope' })).status).toBe(400)
    expect((await put(rule, 'not-a-uuid')).status).toBe(400)
    expect((await put({ ...rule, conditions: [{ field: 'from', value: '' }] })).status).toBe(400)

    const del = await authed(`/api/split-rules/${id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(await (await authed('/api/split-rules')).json()).toEqual([])
  })

  it('registers push subscriptions and saves notification rules', async () => {
    const json = (method: string, body: unknown) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(await (await authed('/api/push/key')).json()).toEqual({ key: 'BPublicKey' })

    const subscription = { endpoint: 'https://push.example/s1', keys: { p256dh: 'p', auth: 'a' } }
    const put = await authed('/api/devices', json('PUT', { kind: 'webpush', subscription }))
    expect(put.status).toBe(200)
    expect(
      (await authed('/api/devices', json('PUT', { kind: 'webpush', subscription: {} }))).status,
    ).toBe(400)
    const devices = () => db.query(`SELECT token FROM devices`)
    expect(await devices()).toEqual([{ token: 'https://push.example/s1' }])
    await authed('/api/devices', json('DELETE', { token: subscription.endpoint }))
    expect(await devices()).toEqual([])

    expect(await (await authed('/api/notification-settings')).json()).toEqual({
      enabled: true,
      splits: ['important'],
      vips: [],
      mutedAccounts: [],
    })
    const saved = await authed(
      '/api/notification-settings',
      json('PUT', { enabled: true, splits: ['important'], vips: ['Mom@x.com'], mutedAccounts: [] }),
    )
    expect(await saved.json()).toMatchObject({ vips: ['mom@x.com'] })
    expect(
      (
        await authed(
          '/api/notification-settings',
          json('PUT', { enabled: true, splits: [], vips: ['nope'], mutedAccounts: [] }),
        )
      ).status,
    ).toBe(400)

    expect((await authed('/api/notifications/test', { method: 'POST' })).status).toBe(202)
    expect(await jobCount('notify.test')).toBe(1)
  })

  it('exports everything as a restorable download and reports backup status', async () => {
    const res = await authed('/api/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(
      /zachhub-export-\d{4}-\d{2}-\d{2}\.ndjson\.gz/,
    )
    const { parseBackup } = await import('@zachhub/backup')
    const backup = parseBackup(new Uint8Array(await res.arrayBuffer()))
    expect(backup.header.userId).toBe(USER)
    expect(backup.rows.get('notification_settings')).toMatchObject([{ vips: ['mom@x.com'] }])
    expect(await (await authed('/api/backup/status')).json()).toEqual({
      latest: null,
      lastOk: null,
    })
  })

  it('queues a send behind the undo window and undoes it', async () => {
    const accountId = (await db.query<{ id: string }>(`SELECT id FROM accounts LIMIT 1`))[0]!.id
    const id = '00000000-0000-4000-8000-0000000000f2'
    const send = (body: unknown) =>
      authed('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const msg = { id, accountId, to: [{ email: 'ana@x.com' }], subject: 'Hi', html: '<p>Hi</p>' }
    const res = await send(msg)
    expect(res.status).toBe(202)
    const { sendAt } = (await res.json()) as { sendAt: number }
    expect(sendAt).toBeGreaterThan(Date.now() + 5_000)
    expect(await (await send(msg)).json()).toEqual({ id, sendAt })

    expect((await send({ ...msg, to: [{ email: 'not an email' }] })).status).toBe(400)
    expect(
      (await send({ ...msg, id: '00000000-0000-4000-8000-0000000000f3', accountId: id })).status,
    ).toBe(422)

    expect((await authed(`/api/send/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await authed(`/api/send/${id}`, { method: 'DELETE' })).status).toBe(409)
    expect((await authed('/api/send/nope', { method: 'DELETE' })).status).toBe(400)
  })

  it('signs attachment uploads into a per-user path', async () => {
    const res = await authed('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'Q4 plan (final).pdf', mime: 'application/pdf', size: 10 }),
    })
    expect(res.status).toBe(201)
    const { id, uploadUrl } = (await res.json()) as { id: string; uploadUrl: string }
    expect(uploadUrl).toBe(
      `${SUPABASE_URL}/storage/v1/object/upload/sign/attachments/${USER}/${id}/Q4_plan_final_.pdf?token=t`,
    )
    const [row] = await db.query<{ filename: string }>(
      `SELECT filename FROM uploads WHERE id = $1`,
      [id],
    )
    expect(row!.filename).toBe('Q4 plan (final).pdf')
    const tooBig = await authed('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'a.bin', mime: 'application/octet-stream', size: 1e9 }),
    })
    expect(tooBig.status).toBe(400)
  })

  it('saves and deletes drafts', async () => {
    const accountId = (await db.query<{ id: string }>(`SELECT id FROM accounts LIMIT 1`))[0]!.id
    const id = '00000000-0000-4000-8000-0000000000f4'
    const put = (body: unknown) =>
      authed(`/api/drafts/${id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const draft = { accountId, subject: '', html: '<p>wip</p>' }
    expect(await (await put(draft)).json()).toEqual({ id, version: 1 })
    expect(await (await put(draft)).json()).toEqual({ id, version: 2 })
    expect(await jobCount('draft.sync')).toBe(1)
    expect((await put({ ...draft, accountId: id })).status).toBe(422)
    expect((await authed(`/api/drafts/${id}`, { method: 'DELETE' })).status).toBe(204)
    expect(
      (await authed('/api/drafts/00000000-0000-4000-8000-0000000000f5', { method: 'DELETE' }))
        .status,
    ).toBe(404)
  })

  it('lists contacts from the mirror', async () => {
    const res = await authed('/api/contacts')
    const { contacts } = (await res.json()) as { contacts: { email: string }[] }
    expect(contacts.map((c) => c.email)).toContain('ana@x.com')
  })

  it('saves snippets and dismisses follow-up nudges', async () => {
    const id = '00000000-0000-4000-8000-0000000000e1'
    const json = (method: string, body: unknown) => ({
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const snippet = { name: 'Call', shortcut: 'Call', html: '<p>Hi {first_name}</p>' }
    expect(await (await authed(`/api/snippets/${id}`, json('PUT', snippet))).json()).toEqual({ id })
    expect(
      (await authed('/api/snippets/00000000-0000-4000-8000-0000000000e2', json('PUT', snippet)))
        .status,
    ).toBe(409)
    expect((await authed(`/api/snippets/${id}`, json('PUT', { name: '' }))).status).toBe(400)
    expect((await authed(`/api/snippets/${id}`, { method: 'DELETE' })).status).toBe(204)

    const threadId = (await db.query<{ id: string }>(`SELECT id FROM threads LIMIT 1`))[0]!.id
    const res = await authed('/api/nudges/dismiss', json('POST', { threadIds: [threadId] }))
    const { dismissed } = (await res.json()) as { dismissed: { id: string }[] }
    expect(dismissed.map((d) => d.id)).toEqual([threadId])
    expect((await authed('/api/nudges/dismiss', json('POST', { threadIds: [] }))).status).toBe(400)
    expect(
      (await authed('/api/nudges/restore', json('POST', { threadIds: [threadId] }))).status,
    ).toBe(204)
  })

  it('returns compacted deltas', async () => {
    const delta = (await (await authed('/api/sync?since=0')).json()) as {
      seq: number
      upserts: { threads: unknown[] }
    }
    expect(delta.seq).toBeGreaterThan(0)
    expect(delta.upserts.threads).toHaveLength(1)
    expect((await authed('/api/sync?since=-1')).status).toBe(400)
  })

  it('searches the mirror and validates its parameters', async () => {
    const r = (await (await authed('/api/search?q=from%3Aana%20hel')).json()) as {
      threads: { subject: string }[]
      messages: unknown[]
      highlight: string[]
    }
    expect(r.threads.map((t) => t.subject)).toEqual(['Hello'])
    expect(r.messages).toHaveLength(1)
    expect(r.highlight).toEqual(['ana', 'hel'])
    const none = (await (await authed('/api/search?q=')).json()) as { threads: unknown[] }
    expect(none.threads).toEqual([])
    expect((await authed('/api/search?q=x&cursor=junk')).status).toBe(400)
    expect((await authed('/api/search?q=x&tz=9999')).status).toBe(400)
    expect((await authed('/api/search?q=x&limit=abc')).status).toBe(400)
  })

  it('streams the bootstrap as NDJSON, gzipped when accepted', async () => {
    const parse = (text: string) =>
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    const plain = parse(await (await authed('/api/bootstrap')).text())
    expect(plain.at(-1)).toHaveProperty('seq')
    expect(plain.flatMap((l) => l.rows?.threads ?? [])).toHaveLength(1)

    const res = await authed('/api/bootstrap', { headers: { 'accept-encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    const gz = parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString())
    expect(gz).toEqual(plain)
  })

  it('fetches, sanitizes and caches message bodies', async () => {
    const res = await authed(`/api/messages/${messageId}/body`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messageId,
      html: '<div style="white-space: pre-wrap">hi &lt;there&gt;</div>',
      hasRemoteImages: false,
    })
    expect((await authed(`/api/messages/not-a-uuid/body`)).status).toBe(400)
    expect((await authed(`/api/messages/00000000-0000-0000-0000-000000000000/body`)).status).toBe(
      404,
    )
  })
})

describe('ai assist', () => {
  let reply: (body: Record<string, unknown>) => FakeReply
  const fake = fakeAnthropic((b) => reply(b))
  const aiApp = () =>
    createApp(env, {
      ...overrides,
      ai: async () => createAi({ apiKey: 'k', baseURL: FAKE_ANTHROPIC_URL, fetch: fake.fetch }),
    })
  const assist = (a: ReturnType<typeof createApp>, body: unknown) =>
    a.request('/api/ai/assist', {
      method: 'POST',
      headers: { authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const read = async (res: Response) => {
    let text = ''
    for await (const t of readAssistStream(res.body!)) text += t
    return text
  }

  it('is off without ANTHROPIC_API_KEY', async () => {
    expect((await assist(app, { mode: 'rewrite', text: 'hi' })).status).toBe(503)
  })

  it('streams a reply drafted from the thread', async () => {
    reply = () => ({ chunks: ['Sure, ', 'Friday works.'] })
    const threadId = (await db.query<{ id: string }>(`SELECT id FROM threads LIMIT 1`))[0]!.id
    const res = await assist(aiApp(), { mode: 'draft', threadId, instruction: 'say yes' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    expect(await read(res)).toBe('Sure, Friday works.')
    const prompt = JSON.stringify(fake.requests.at(-1)!.body.messages)
    expect(prompt).toContain('hi <there>') // body text, fetched from the provider
    expect(prompt).toContain('zach@gmail.com') // writing as the thread's account
  })

  it('rewrites text and reports declines and failures in-stream', async () => {
    reply = () => ({ chunks: ['Shorter.'] })
    expect(await read(await assist(aiApp(), { mode: 'rewrite', text: 'A long draft' }))).toBe(
      'Shorter.',
    )
    reply = () => ({ chunks: [], stopReason: 'refusal' })
    await expect(read(await assist(aiApp(), { mode: 'rewrite', text: 'x' }))).rejects.toThrow(
      'declined',
    )
    reply = () => ({ status: 400 })
    await expect(read(await assist(aiApp(), { mode: 'rewrite', text: 'x' }))).rejects.toThrow(
      'unavailable',
    )
  })

  it('validates requests', async () => {
    expect((await assist(aiApp(), { mode: 'summarize' })).status).toBe(400)
    expect((await assist(aiApp(), { mode: 'shout', text: 'x' })).status).toBe(400)
    const missing = '00000000-0000-4000-8000-0000000000aa'
    expect((await assist(aiApp(), { mode: 'summarize', threadId: missing })).status).toBe(404)
  })
})

describe('image proxy', () => {
  it('serves signed public images and refuses unsigned or private targets', async () => {
    const ok = proxiedImageUrl('http://93.184.216.34/p.png', env.IMAGE_PROXY_SECRET!)
    const res = await app.request(ok)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')

    expect(
      (await app.request('/api/img?u=http%3A%2F%2F93.184.216.34%2Fp.png&s=forged')).status,
    ).toBe(403)
    expect(
      (await app.request(proxiedImageUrl('http://169.254.169.254/latest', env.IMAGE_PROXY_SECRET!)))
        .status,
    ).toBe(403)
    expect(
      (await app.request(proxiedImageUrl('http://127.0.0.1/x.png', env.IMAGE_PROXY_SECRET!)))
        .status,
    ).toBe(403)
  })
})

describe('outlook connect', () => {
  async function start(query = '') {
    const res = await authed(`/api/accounts/connect/graph${query}`, { method: 'POST' })
    const { url } = (await res.json()) as { url: string }
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    return { url: new URL(url), cookie }
  }
  const callback = (query: string, cookie: string) =>
    app.request(`/api/accounts/callback/graph?${query}`, { headers: { cookie } })

  it('signs in through Microsoft with PKCE and creates the account', async () => {
    const { url, cookie } = await start('?hint=zach%40zachconrad.dev')
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    )
    expect(url.searchParams.get('scope')).toContain('Mail.ReadWrite')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    expect(url.searchParams.get('login_hint')).toBe('zach@zachconrad.dev')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://mail.example.com/api/accounts/callback/graph',
    )

    const res = await callback(`code=ms-code&state=${url.searchParams.get('state')}`, cookie)
    expect(res.headers.get('location')).toBe('/?connected=Zach%40ZachConrad.dev')
    const [acct] = await db.query<{ email: string; display_name: string }>(
      `SELECT email, display_name FROM accounts WHERE provider = 'graph'`,
    )
    expect(acct).toEqual({ email: 'zach@zachconrad.dev', display_name: 'Zach' })
  })

  it('turns a blocked user consent into an admin-consent prompt', async () => {
    const { url, cookie } = await start()
    const res = await callback(
      `error=access_denied&error_description=${encodeURIComponent('AADSTS90094: Admin consent is required')}&state=${url.searchParams.get('state')}`,
      cookie,
    )
    expect(res.headers.get('location')).toBe(
      '/?connect_error=admin_consent_required&provider=graph',
    )
  })

  it('runs tenant-wide admin consent, then carries on into sign-in', async () => {
    const { url, cookie } = await start('?admin=1')
    expect(url.pathname).toBe('/organizations/v2.0/adminconsent')
    expect(url.searchParams.get('scope')).toContain('https://graph.microsoft.com/Mail.Send')

    const res = await callback(
      `admin_consent=True&tenant=t1&state=${url.searchParams.get('state')}`,
      cookie,
    )
    const next = new URL(res.headers.get('location')!)
    expect(next.pathname).toBe('/common/oauth2/v2.0/authorize')
    expect(res.headers.get('set-cookie')).toContain('zm_oauth=')

    const denied = await start('?admin=1')
    expect(
      (
        await callback(
          `error=access_denied&state=${denied.url.searchParams.get('state')}`,
          denied.cookie,
        )
      ).headers.get('location'),
    ).toBe('/?connect_error=access_denied&provider=graph')
  })
})

describe('outlook webhook', () => {
  const notify = (body: unknown, query = '') =>
    app.request(`/webhooks/graph${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('echoes the validation token', async () => {
    const res = await notify({}, '?validationToken=abc%20123')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc 123')
  })

  it('syncs on notifications that carry the account clientState only', async () => {
    const [acct] = await db.query<{ id: string }>(
      `UPDATE accounts SET sync_state = '{"subscriptionId":"sub-1"}' WHERE provider = 'graph' RETURNING id`,
    )
    await db.query(`DELETE FROM jobs`)
    const good = graphClientState(env.GRAPH_WEBHOOK_SECRET!, acct!.id)
    expect(
      (await notify({ value: [{ subscriptionId: 'sub-1', clientState: 'forged' }] })).status,
    ).toBe(202)
    expect(await jobCount('account.sync')).toBe(0)

    await notify({
      value: [
        { subscriptionId: 'sub-1', clientState: good },
        { subscriptionId: 'sub-1', clientState: good },
      ],
    })
    expect(await jobCount('account.sync')).toBe(1)

    await notify({
      value: [
        { subscriptionId: 'sub-1', clientState: good, lifecycleEvent: 'reauthorizationRequired' },
      ],
    })
    expect(await jobCount('gmail.watch')).toBe(1)
  })
})

describe('vercel path restore', () => {
  it('puts the original path back and keeps the query', async () => {
    const { restorePath } = await import('./vercel-path')
    expect(restorePath('/api?__zm_path=/api/sync&since=5')).toBe('/api/sync?since=5')
    expect(restorePath('/api?__zm_path=/webhooks/gmail')).toBe('/webhooks/gmail')
    expect(restorePath('/api/sync?since=1')).toBe('/api/sync?since=1')
  })
})
