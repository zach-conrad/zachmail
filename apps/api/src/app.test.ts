import { applySyncBatch, saveCredentials, type Db } from '@zachmail/db/server'
import { USER, createTestDb, type TestDb } from '@zachmail/db/testing'
import { proxiedImageUrl } from '@zachmail/engine'
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
  if (url.pathname.endsWith('/profile'))
    return json({ emailAddress: 'Zach@Gmail.com', historyId: '1' })
  if (url.pathname.includes('/messages/pm1'))
    return json({
      id: 'pm1',
      threadId: 'pt1',
      payload: { mimeType: 'text/plain', body: { data: b64('hi <there>') } },
    })
  if (url.host === '93.184.216.34')
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  return json({}, 404)
}

let t: TestDb
let db: Db
let app: ReturnType<typeof createApp>
let userToken: string
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
  app = createApp(env, {
    db: () => db,
    fetch: fakeFetch as never,
    supabaseKeys: createLocalJWKSet({ keys: [await jwks(supa.publicKey, 's1', 'ES256')] }),
    googleKeys: createLocalJWKSet({ keys: [await jwks(goog.publicKey, 'g1', 'RS256')] }),
  })
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

  it('returns compacted deltas', async () => {
    const delta = (await (await authed('/api/sync?since=0')).json()) as {
      seq: number
      upserts: { threads: unknown[] }
    }
    expect(delta.seq).toBeGreaterThan(0)
    expect(delta.upserts.threads).toHaveLength(1)
    expect((await authed('/api/sync?since=-1')).status).toBe(400)
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

describe('vercel path restore', () => {
  it('puts the original path back and keeps the query', async () => {
    const { restorePath } = await import('./vercel-path')
    expect(restorePath('/api?__zm_path=/api/sync&since=5')).toBe('/api/sync?since=5')
    expect(restorePath('/api?__zm_path=/webhooks/gmail')).toBe('/webhooks/gmail')
    expect(restorePath('/api/sync?since=1')).toBe('/api/sync?since=1')
  })
})
