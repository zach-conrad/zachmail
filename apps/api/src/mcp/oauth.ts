/**
 * OAuth 2.1 authorization server for the Claude connector (MCP authorization spec: RFC 9728
 * resource metadata, RFC 8414 server metadata, RFC 7591 dynamic client registration, PKCE S256).
 *
 * Everything is stateless signed JWTs, so there are no tables and no DB hop per MCP call:
 * client ids carry their redirect URIs, codes carry the PKCE challenge, access tokens verify
 * locally. Signing in goes through Supabase Auth (Google) and the same email allowlist as the
 * app, followed by a consent page. Rotating MCP_TOKEN_SECRET revokes every connector session.
 */
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { createHash, hkdfSync, randomBytes } from 'node:crypto'
import { allowlist, supabaseVerifier, type AuthVariables } from '../auth'
import type { Deps } from '../deps'
import type { Env } from '../env'

export const MCP_PATH = '/api/mcp'
const OAUTH = `${MCP_PATH}/oauth`
const COOKIE = 'zm_mcp'
const SCOPE = 'mail'
const ACCESS_TTL = 3600
const REFRESH_TTL = '30d'

/** Claude's hosted callbacks; Claude Code and Desktop use loopback URIs, allowed separately. */
const CLAUDE_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]

type TokenType = 'client' | 'pending' | 'approve' | 'code' | 'at' | 'rt'

/** The parts of an authorization request that ride through sign-in and consent. */
interface AuthRequest {
  cid: string
  ru: string
  cc: string
  st?: string
}

export interface McpOAuth {
  origin: string
  resource: string
  sign(typ: TokenType, claims: JWTPayload, ttl?: string | number): Promise<string>
  verify<T extends JWTPayload>(typ: TokenType, token: string): Promise<T | null>
  redirectAllowed(uri: string): boolean
  emailAllowed(email: string): boolean
}

export function mcpOAuth(env: Env): McpOAuth | null {
  const secret = env.MCP_TOKEN_SECRET ?? env.OAUTH_STATE_SECRET
  if (!secret) return null
  const key = new Uint8Array(hkdfSync('sha256', secret, '', 'zachmail-mcp-v1', 32))
  const origin = env.APP_ORIGIN.replace(/\/$/, '')
  const extra = (env.MCP_REDIRECT_URIS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  const exact = new Set([...CLAUDE_REDIRECTS, ...extra])
  const allowed = allowlist(env.ALLOWED_EMAILS)
  return {
    origin,
    resource: `${origin}${MCP_PATH}`,
    async sign(typ, claims, ttl = '10m') {
      return new SignJWT({ ...claims, typ })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(origin)
        .setIssuedAt()
        .setExpirationTime(typeof ttl === 'number' ? Math.floor(Date.now() / 1000) + ttl : ttl)
        .sign(key)
    },
    async verify<T extends JWTPayload>(typ: TokenType, token: string) {
      try {
        const { payload } = await jwtVerify(token, key, { issuer: origin, algorithms: ['HS256'] })
        return payload.typ === typ ? (payload as T) : null
      } catch {
        return null
      }
    },
    redirectAllowed(uri) {
      if (exact.has(uri)) return true
      try {
        const u = new URL(uri)
        return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
      } catch {
        return false
      }
    },
    emailAllowed: (email) => allowed.has(email.toLowerCase()),
  }
}

/** Client ids never expire; a long TTL keeps `sign` uniform. */
const CLIENT_TTL = '3650d'

const s256 = (v: string) => createHash('sha256').update(v).digest('base64url')

/** /.well-known documents (mounted at the site root). */
export function wellKnownRoutes(oauth: McpOAuth | null) {
  const app = new Hono()
  const resource = (c: Context) => {
    if (!oauth) throw new HTTPException(404, { message: 'Connector not configured' })
    return c.json({
      resource: oauth.resource,
      authorization_servers: [oauth.origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'ZachMail',
    })
  }
  app.get('/oauth-protected-resource', resource)
  app.get(`/oauth-protected-resource${MCP_PATH}`, resource)
  app.get('/oauth-authorization-server', (c) => {
    if (!oauth) throw new HTTPException(404, { message: 'Connector not configured' })
    const o = oauth.origin
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}${OAUTH}/authorize`,
      token_endpoint: `${o}${OAUTH}/token`,
      registration_endpoint: `${o}${OAUTH}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    })
  })
  return app
}

/** /api/mcp/oauth/*: registration, sign-in, consent and tokens. */
export function oauthRoutes(env: Env, deps: Deps, oauth: McpOAuth | null) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    if (!oauth) throw new HTTPException(503, { message: 'The Claude connector is not set up' })
    await next()
  })
  const o = oauth!
  const supabase = env.SUPABASE_URL.replace(/\/$/, '')
  const verifySupabase = supabaseVerifier({
    supabaseUrl: env.SUPABASE_URL,
    allowedEmails: env.ALLOWED_EMAILS,
    keys: deps.supabaseKeys,
  })
  const callbackUrl = () => `${o.origin}${OAUTH}/callback`

  app.post('/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      redirect_uris?: unknown
      client_name?: unknown
    } | null
    const uris = body?.redirect_uris
    if (
      !Array.isArray(uris) ||
      !uris.length ||
      uris.length > 10 ||
      !uris.every((u) => typeof u === 'string' && o.redirectAllowed(u))
    )
      return c.json(
        { error: 'invalid_redirect_uri', error_description: 'Redirect URI not allowed' },
        400,
      )
    const name = typeof body?.client_name === 'string' ? body.client_name.slice(0, 80) : 'Claude'
    const clientId = await o.sign('client', { r: uris, n: name }, CLIENT_TTL)
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      },
      201,
    )
  })

  // Step 1: Claude sends the browser here. Validate, then sign in with Supabase (PKCE).
  app.get('/authorize', async (c) => {
    const q = c.req.query()
    const client = q.client_id
      ? await o.verify<{ r: string[]; n: string }>('client', q.client_id)
      : null
    if (!client)
      return page(c, 400, 'Unknown app', 'Remove the connector in Claude and add it again.')
    const redirectUri = q.redirect_uri ?? (client.r.length === 1 ? client.r[0]! : '')
    if (!client.r.includes(redirectUri) || !o.redirectAllowed(redirectUri))
      return page(c, 400, 'Redirect not allowed', 'This sign-in link is not for ZachMail.')
    const back = (error: string) => redirectTo(c, redirectUri, { error, state: q.state }, o.origin)
    if (q.response_type !== 'code') return back('unsupported_response_type')
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request')
    if (q.resource && q.resource !== o.resource && q.resource !== o.origin)
      return back('invalid_target')

    const verifier = randomBytes(32).toString('base64url')
    const req: AuthRequest = {
      cid: q.client_id!,
      ru: redirectUri,
      cc: q.code_challenge,
      ...(q.state ? { st: q.state } : {}),
    }
    setCookie(c, COOKIE, await o.sign('pending', { v: verifier, q: req }), {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: OAUTH,
      maxAge: 600,
    })
    const login = new URL(`${supabase}/auth/v1/authorize`)
    login.searchParams.set('provider', 'google')
    login.searchParams.set('redirect_to', callbackUrl())
    login.searchParams.set('code_challenge', s256(verifier))
    login.searchParams.set('code_challenge_method', 's256')
    return c.redirect(login.toString(), 302)
  })

  // Step 2: Supabase returns here signed in. Check the allowlist, then ask for consent.
  app.get('/callback', async (c) => {
    const cookie = getCookie(c, COOKIE)
    deleteCookie(c, COOKIE, { path: OAUTH, secure: true })
    const pending = cookie ? await o.verify<{ v: string; q: AuthRequest }>('pending', cookie) : null
    if (!pending) return page(c, 400, 'Sign-in expired', 'Start connecting again from Claude.')
    const { code, error_description: err } = c.req.query()
    if (!code) return page(c, 400, 'Sign-in failed', err ?? 'Google did not sign you in.')
    if (!env.SUPABASE_PUBLISHABLE_KEY)
      return page(c, 503, 'Not set up', 'SUPABASE_PUBLISHABLE_KEY is missing on the server.')

    const res = await deps.fetch(`${supabase}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ auth_code: code, code_verifier: pending.v }),
    })
    const session = res.ok ? ((await res.json()) as { access_token?: string }) : null
    if (!session?.access_token) return page(c, 400, 'Sign-in failed', 'Try connecting again.')
    let user
    try {
      user = await verifySupabase(session.access_token)
    } catch {
      return page(c, 403, 'Not allowed', 'This Google account cannot use ZachMail.')
    }

    const client = await o.verify<{ n: string }>('client', pending.q.cid)
    const t = await o.sign('approve', { sub: user.id, email: user.email, q: pending.q }, '5m')
    const host = new URL(pending.q.ru).host
    return consent(c, client?.n ?? 'Claude', host, user.email, t)
  })

  // Step 3: the consent page's buttons. Issue a code (or a denial) back to Claude.
  app.get('/approve', async (c) => {
    const t = c.req.query('t')
    const ok = t
      ? await o.verify<{ sub: string; email: string; q: AuthRequest }>('approve', t)
      : null
    if (!ok) return page(c, 400, 'Link expired', 'Start connecting again from Claude.')
    if (c.req.query('deny'))
      return redirectTo(c, ok.q.ru, { error: 'access_denied', state: ok.q.st }, o.origin)
    const code = await o.sign(
      'code',
      { sub: ok.sub, email: ok.email, cid: ok.q.cid, ru: ok.q.ru, cc: ok.q.cc },
      '2m',
    )
    return redirectTo(c, ok.q.ru, { code, state: ok.q.st }, o.origin)
  })

  app.post('/token', async (c) => {
    c.header('cache-control', 'no-store')
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>)
    const p = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : undefined)
    const fail = (error: string, description: string) =>
      c.json({ error, error_description: description }, 400)

    let sub: string, email: string, cid: string
    if (p('grant_type') === 'authorization_code') {
      const code = await o.verify<{
        sub: string
        email: string
        cid: string
        ru: string
        cc: string
      }>('code', p('code') ?? '')
      if (!code) return fail('invalid_grant', 'Code is invalid or expired')
      if (p('client_id') && p('client_id') !== code.cid)
        return fail('invalid_grant', 'Code was issued to another client')
      if (p('redirect_uri') && p('redirect_uri') !== code.ru)
        return fail('invalid_grant', 'redirect_uri does not match')
      const verifier = p('code_verifier')
      if (!verifier || s256(verifier) !== code.cc)
        return fail('invalid_grant', 'PKCE verification failed')
      ;({ sub, email, cid } = code)
    } else if (p('grant_type') === 'refresh_token') {
      const rt = await o.verify<{ sub: string; email: string; cid: string }>(
        'rt',
        p('refresh_token') ?? '',
      )
      if (!rt) return fail('invalid_grant', 'Refresh token is invalid or expired')
      if (p('client_id') && p('client_id') !== rt.cid)
        return fail('invalid_grant', 'Refresh token was issued to another client')
      ;({ sub, email, cid } = rt)
    } else {
      return fail('unsupported_grant_type', 'Use authorization_code or refresh_token')
    }
    if (!o.emailAllowed(email)) return fail('invalid_grant', 'This account is no longer allowed')

    const claims = { sub, email, cid }
    return c.json({
      access_token: await o.sign('at', { ...claims, aud: o.resource, scope: SCOPE }, ACCESS_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: await o.sign('rt', claims, REFRESH_TTL),
      scope: SCOPE,
    })
  })

  return app
}

/** Bearer check for /api/mcp. Local HMAC verification only: no network, no DB. */
export function requireMcpToken(oauth: McpOAuth | null) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (!oauth) throw new HTTPException(503, { message: 'The Claude connector is not set up' })
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
    const at = token
      ? await oauth.verify<{ sub: string; email: string; aud: string }>('at', token)
      : null
    if (!at || at.aud !== oauth.resource || !oauth.emailAllowed(at.email)) {
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${oauth.origin}/.well-known/oauth-protected-resource${MCP_PATH}"` +
          (token ? ', error="invalid_token"' : ''),
      )
      return c.json({ error: token ? 'Invalid token' : 'Missing bearer token' }, 401)
    }
    c.set('user', { id: at.sub, email: at.email })
    await next()
  })
}

function redirectTo(
  c: Context,
  uri: string,
  params: Record<string, string | undefined>,
  issuer: string,
) {
  const url = new URL(uri)
  for (const [k, v] of Object.entries({ ...params, iss: issuer }))
    if (v !== undefined) url.searchParams.set(k, v)
  return c.redirect(url.toString(), 302)
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )

/** Minimal server-rendered pages: no scripts, system colors, nothing to load. */
function shell(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ZachMail</title>
<style>:root{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:26rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;opacity:.8}.row{display:flex;gap:.75rem;margin-top:1.5rem}a.b{flex:1;text-align:center;padding:.6rem 1rem;border-radius:.5rem;text-decoration:none;border:1px solid ButtonBorder;color:ButtonText;background:ButtonFace}a.b.primary{background:CanvasText;color:Canvas;border-color:CanvasText}</style>
</head><body><main>${body}</main></body></html>`
}

function page(c: Context, status: 400 | 403 | 503, title: string, detail: string) {
  c.header('cache-control', 'no-store')
  return c.html(shell(title, `<h1>${esc(title)}</h1><p>${esc(detail)}</p>`), status)
}

function consent(c: Context, client: string, host: string, email: string, token: string) {
  c.header('cache-control', 'no-store')
  const href = `${OAUTH}/approve?t=${encodeURIComponent(token)}`
  return c.html(
    shell(
      'Connect to Claude',
      `<h1>Let ${esc(client)} use ZachMail?</h1>
<p>It will be able to search and read your mail, triage threads, write drafts and send mail as
${esc(email)}.</p>
<p>Returning to <strong>${esc(host)}</strong>.</p>
<div class="row"><a class="b" href="${href}&amp;deny=1">Cancel</a><a class="b primary" href="${href}">Allow</a></div>`,
    ),
  )
}
