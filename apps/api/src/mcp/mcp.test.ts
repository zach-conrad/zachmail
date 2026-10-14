import { applySyncBatch, saveCredentials, type Db } from '@zachmail/db/server'
import { USER, createTestDb, type TestDb } from '@zachmail/db/testing'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app'
import type { Env } from '../env'

const SUPABASE_URL = 'https://example.supabase.co'
const ORIGIN = 'https://mail.example.com'
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const env: Env = {
  SUPABASE_URL,
  ALLOWED_EMAILS: 'zach@example.com',
  APP_ORIGIN: ORIGIN,
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  OAUTH_STATE_SECRET: 'state-secret',
  IMAGE_PROXY_SECRET: 'img-secret',
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SUPABASE_PUBLISHABLE_KEY: 'pk',
}

const b64 = (s: string) => Buffer.from(s).toString('base64url')
const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

let t: TestDb
let db: Db
let app: ReturnType<typeof createApp>
/** Supabase access tokens the fake /auth/v1/token hands out, by auth code. */
const supabaseSessions = new Map<string, string>()
let lastPkce: { auth_code: string; code_verifier: string } | undefined
let accountId: string
let threadId: string
let messageIds: string[]

const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input))
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
  if (url.host === 'example.supabase.co' && url.pathname === '/auth/v1/token') {
    lastPkce = JSON.parse(String(init?.body))
    const token = supabaseSessions.get(lastPkce!.auth_code)
    return token ? json({ access_token: token }) : json({ error: 'bad_code' }, 400)
  }
  if (url.host === 'oauth2.googleapis.com') return json({ access_token: 'at', expires_in: 3600 })
  if (url.pathname.includes('/messages/pm2'))
    return json({
      id: 'pm2',
      threadId: 'pt1',
      payload: { mimeType: 'text/html', body: { data: b64('<p>Lunch <b>Friday</b>?</p>') } },
    })
  return json({}, 404)
}

beforeAll(async () => {
  t = await createTestDb()
  db = t.db
  const supa = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(supa.publicKey)), kid: 's1', alg: 'ES256' }
  app = createApp(env, {
    db: () => db,
    fetch: fakeFetch as never,
    supabaseKeys: createLocalJWKSet({ keys: [jwk] }),
  })
  const supabaseToken = (email: string) =>
    new SignJWT({ email })
      .setProtectedHeader({ alg: 'ES256', kid: 's1' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setAudience('authenticated')
      .setSubject(USER)
      .setExpirationTime('5m')
      .sign(supa.privateKey)
  supabaseSessions.set('good', await supabaseToken('Zach@example.com'))
  supabaseSessions.set('stranger', await supabaseToken('eve@example.com'))

  const [acct] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email, status)
     VALUES ($1, 'gmail', 'zach@gmail.com', 'active') RETURNING id`,
    [USER],
  )
  accountId = acct!.id
  await saveCredentials(db, Buffer.from(env.TOKEN_ENCRYPTION_KEY!, 'base64'), {
    accountId,
    userId: USER,
    secret: { refreshToken: 'rt' },
  })
  const msg = (n: number, from: string, subject: string, snippet: string) => ({
    providerMessageId: `pm${n}`,
    providerThreadId: 'pt1',
    rfc822MessageId: `<m${n}@x>`,
    inReplyTo: null,
    references: [],
    from: { email: from, name: 'Ana Ruiz' },
    to: [{ email: 'zach@gmail.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject,
    snippet,
    date: new Date(Date.now() - (3 - n) * 60_000),
    folderIds: ['INBOX'],
    unread: true,
    starred: false,
    hasAttachments: false,
    listUnsubscribe: null,
    size: 1,
    attachments: [],
  })
  await applySyncBatch(db, {
    userId: USER,
    accountId,
    batch: {
      folders: [
        { providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 2, totalCount: 2 },
        { providerId: 'L1', name: 'Receipts', kind: 'custom', unreadCount: 0, totalCount: 0 },
      ],
      deletedMessageIds: [],
      messages: [
        msg(1, 'ana@x.com', 'Lunch plans', 'are you free'),
        msg(2, 'ana@x.com', 'Re: Lunch plans', 'Lunch Friday?'),
      ],
    },
  })
  threadId = (await db.query<{ id: string }>(`SELECT id FROM threads LIMIT 1`))[0]!.id
  messageIds = (await db.query<{ id: string }>(`SELECT id FROM messages ORDER BY date`)).map(
    (m) => m.id,
  )
  await db.query(
    `INSERT INTO message_bodies (message_id, user_id, html, text) VALUES ($1, $2, '<p>hi</p>', 'Are you free this week?')`,
    [messageIds[0], USER],
  )
})
afterAll(() => t.close())

const form = (body: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
})

/** Runs the whole connector sign-in the way claude.ai does and returns the token response. */
async function connect(supabaseCode = 'good', deny = false) {
  const reg = await app.request('/api/mcp/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK] }),
  })
  expect(reg.status).toBe(201)
  const { client_id } = (await reg.json()) as { client_id: string }

  const verifier = randomBytes(32).toString('base64url')
  const authorize = await app.request(
    `/api/mcp/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: CALLBACK,
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      state: 'st8',
      scope: 'mail',
      resource: `${ORIGIN}/api/mcp`,
    })}`,
  )
  expect(authorize.status).toBe(302)
  const login = new URL(authorize.headers.get('location')!)
  expect(login.origin + login.pathname).toBe(`${SUPABASE_URL}/auth/v1/authorize`)
  expect(login.searchParams.get('provider')).toBe('google')
  expect(login.searchParams.get('redirect_to')).toBe(`${ORIGIN}/api/mcp/oauth/callback`)
  const cookie = authorize.headers.get('set-cookie')!.split(';')[0]!

  const callback = await app.request(`/api/mcp/oauth/callback?code=${supabaseCode}`, {
    headers: { cookie },
  })
  if (callback.status !== 200) return { callback }
  // Supabase PKCE: the verifier we keep matches the challenge we sent.
  expect(s256(lastPkce!.code_verifier)).toBe(login.searchParams.get('code_challenge'))
  const html = await callback.text()
  expect(html).toContain('Let Claude use ZachMail?')
  const approve = html.match(/href="([^"]+)">Allow/)![1]!.replace(/&amp;/g, '&')
  if (deny) return { callback, denied: await app.request(`${approve}&deny=1`) }

  const back = await app.request(approve)
  expect(back.status).toBe(302)
  const redirect = new URL(back.headers.get('location')!)
  expect(redirect.origin + redirect.pathname).toBe(CALLBACK)
  expect(redirect.searchParams.get('state')).toBe('st8')
  expect(redirect.searchParams.get('iss')).toBe(ORIGIN)

  const token = await app.request(
    '/api/mcp/oauth/token',
    form({
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code')!,
      redirect_uri: CALLBACK,
      client_id,
      code_verifier: verifier,
    }),
  )
  return { callback, client_id, verifier, code: redirect.searchParams.get('code')!, token }
}

let accessToken: string

const rpc = async (method: string, params?: unknown, token = accessToken) =>
  app.request('/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })

async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) {
  const res = await rpc('tools/call', { name, arguments: args })
  expect(res.status).toBe(200)
  const { result } = (await res.json()) as {
    result: { isError?: boolean; content: { text: string }[]; structuredContent?: T }
  }
  return (result.isError ? { error: result.content[0]!.text } : result.structuredContent) as T & {
    error?: string
  }
}

describe('connector discovery', () => {
  it('points an unauthenticated client at the OAuth metadata', async () => {
    const res = await rpc('initialize', {}, '')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`,
    )
    const prm = await (await app.request('/.well-known/oauth-protected-resource/api/mcp')).json()
    expect(prm).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] })
    const as = (await (await app.request('/.well-known/oauth-authorization-server')).json()) as {
      issuer: string
      registration_endpoint: string
      code_challenge_methods_supported: string[]
    }
    expect(as.issuer).toBe(ORIGIN)
    expect(as.registration_endpoint).toBe(`${ORIGIN}/api/mcp/oauth/register`)
    expect(as.code_challenge_methods_supported).toEqual(['S256'])
  })

  it('only registers Claude and loopback redirect URIs', async () => {
    const reg = (uris: string[]) =>
      app.request('/api/mcp/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ redirect_uris: uris }),
      })
    expect((await reg(['https://evil.example/cb'])).status).toBe(400)
    expect((await reg(['http://localhost:33418/callback'])).status).toBe(201)
  })
})

describe('connector sign-in', () => {
  it('issues tokens after Google sign-in and consent, with PKCE and one client', async () => {
    const { token, client_id, code } = await connect()
    expect(token!.status).toBe(200)
    const body = (await token!.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
    }
    expect(body.expires_in).toBe(3600)
    accessToken = body.access_token

    // Wrong verifier, wrong client.
    const bad = await app.request(
      '/api/mcp/oauth/token',
      form({
        grant_type: 'authorization_code',
        code: code!,
        code_verifier: 'nope',
        client_id: client_id!,
      }),
    )
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ error: 'invalid_grant' })

    const refreshed = await app.request(
      '/api/mcp/oauth/token',
      form({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: client_id!,
      }),
    )
    expect(refreshed.status).toBe(200)
    // A refresh token is not an access token.
    expect((await rpc('ping', undefined, body.refresh_token)).status).toBe(401)
  })

  it('refuses Google accounts that are not on the allowlist', async () => {
    const { callback } = await connect('stranger')
    expect(callback.status).toBe(403)
  })

  it('sends a denial back to Claude from Cancel', async () => {
    const { denied } = await connect('good', true)
    const back = new URL(denied!.headers.get('location')!)
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
  })
})

describe('mcp tools', () => {
  it('initializes and lists tools', async () => {
    const init = (await (await rpc('initialize', { protocolVersion: '2025-06-18' })).json()) as {
      result: { protocolVersion: string; capabilities: unknown }
    }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } })
    const list = (await (await rpc('tools/list')).json()) as {
      result: { tools: { name: string }[] }
    }
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'list_accounts',
      'search_threads',
      'get_thread',
      'triage_threads',
      'label_threads',
      'save_draft',
      'send_email',
      'cancel_send',
    ])
    // Notifications get no body.
    const note = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(note.status).toBe(202)
  })

  it('lists accounts and searches threads', async () => {
    const { accounts } = await call<{ accounts: { email: string; folders: { name: string }[] }[] }>(
      'list_accounts',
    )
    expect(accounts[0]!.email).toBe('zach@gmail.com')
    expect(accounts[0]!.folders.map((f) => f.name).sort()).toEqual(['Inbox', 'Receipts'])

    const inbox = await call<{ threads: { id: string; labels: string[] }[] }>('search_threads')
    expect(inbox.threads.map((x) => x.id)).toEqual([threadId])
    expect(inbox.threads[0]!.labels).toEqual(['Inbox'])
    expect(
      (await call<{ threads: unknown[] }>('search_threads', { query: 'lunch' })).threads,
    ).toHaveLength(1)
    expect(
      (await call<{ threads: unknown[] }>('search_threads', { query: 'dinner' })).threads,
    ).toHaveLength(0)
    expect(
      (await call<{ threads: unknown[] }>('search_threads', { from: 'ana@' })).threads,
    ).toHaveLength(1)
    expect(
      (await call<{ threads: unknown[] }>('search_threads', { query: '100%' })).threads,
    ).toHaveLength(0)
  })

  it('reads a thread, fetching bodies that are not cached yet', async () => {
    const thread = await call<{ messages: { id: string; body: string }[] }>('get_thread', {
      thread_id: threadId,
    })
    expect(thread.messages.map((m) => m.body)).toEqual(['Are you free this week?', 'Lunch Friday?'])
    expect((await call('get_thread', { thread_id: 'nope' })).error).toBe('thread_id must be an id')
  })

  it('triages and labels through the outbox', async () => {
    expect(await call('triage_threads', { thread_ids: [threadId], action: 'read' })).toMatchObject({
      ok: true,
    })
    const [row] = await db.query<{ unread: boolean }>(`SELECT unread FROM threads WHERE id = $1`, [
      threadId,
    ])
    expect(row!.unread).toBe(false)
    expect(
      await call('label_threads', { thread_ids: [threadId], add: ['receipts'] }),
    ).toMatchObject({
      ok: true,
    })
    const labels = await call<{ threads: { labels: string[] }[] }>('search_threads', {
      folder: 'Receipts',
    })
    expect(labels.threads[0]!.labels).toEqual(['Inbox', 'Receipts'])
    expect(
      (await call('label_threads', { thread_ids: [threadId], add: ['Nope'] })).error,
    ).toContain('No label named')
    const outbox = await db.query(`SELECT kind FROM outbox ORDER BY seq`)
    expect(outbox.map((o) => (o as { kind: string }).kind)).toEqual(['read', 'label'])
  })

  it('drafts and sends replies with sensible defaults, and cancels a send', async () => {
    const draft = await call<{ draft_id: string; to: unknown; subject: string }>('save_draft', {
      reply_to_message_id: messageIds[1],
      body: 'Friday works.',
    })
    expect(draft.to).toEqual([{ email: 'ana@x.com', name: 'Ana Ruiz' }])
    expect(draft.subject).toBe('Re: Lunch plans')
    const [saved] = await db.query<{ payload: { html: string } }>(
      `SELECT payload FROM drafts WHERE id = $1`,
      [draft.draft_id],
    )
    expect(saved!.payload.html).toContain('Friday works.')

    const sent = await call<{ send_id: string; sends_at: string }>('send_email', {
      to: ['Bo <bo@y.com>'],
      subject: 'Hi',
      body: 'Hello',
    })
    expect(new Date(sent.sends_at).getTime()).toBeGreaterThan(Date.now() + 5_000)
    expect(await call('cancel_send', { send_id: sent.send_id })).toEqual({ cancelled: true })
    expect((await call('cancel_send', { send_id: sent.send_id })).error).toContain('Too late')
    expect((await call('send_email', { body: 'x' })).error).toBe('add at least one recipient')
    expect((await call('send_email', { to: ['not an address'], body: 'x' })).error).toContain(
      'not an email address',
    )
  })
})
