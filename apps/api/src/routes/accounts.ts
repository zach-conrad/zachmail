import { enqueueInitialSync, enqueueSync } from '@zachmail/engine'
import { saveCredentials, type Db } from '@zachmail/db/server'
import { GmailProvider, buildAuthUrl, exchangeCode } from '@zachmail/providers/gmail'
import {
  GraphProvider,
  buildAdminConsentUrl,
  buildMicrosoftAuthUrl,
  exchangeMicrosoftCode,
} from '@zachmail/providers/graph'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { SignJWT, jwtVerify } from 'jose'
import { createHash, randomBytes } from 'node:crypto'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'
import { required, type Env } from '../env'

const COOKIE = 'zm_oauth'
const CALLBACK = { gmail: '/api/accounts/callback/gmail', graph: '/api/accounts/callback/graph' }
type Provider = keyof typeof CALLBACK

const b64url = (b: Buffer) => b.toString('base64url')

/**
 * Starts an OAuth round trip: a signed state naming the user (and whether this is the
 * tenant-wide admin consent step), plus a callback-scoped cookie holding the PKCE verifier.
 */
async function beginOAuth(c: Context, env: Env, provider: Provider, userId: string, admin = false) {
  const verifier = b64url(randomBytes(32))
  const nonce = b64url(randomBytes(16))
  const state = await new SignJWT({ n: nonce, ...(admin ? { a: 1 } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setExpirationTime('10m')
    .sign(stateKey(env))
  setCookie(c, COOKIE, `${nonce}.${verifier}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: CALLBACK[provider],
    maxAge: 600,
  })
  return { state, codeChallenge: b64url(createHash('sha256').update(verifier).digest()) }
}

/** Checks the state against the cookie; returns the user and PKCE verifier, or a failure. */
async function finishOAuth(c: Context, env: Env, provider: Provider, state: string) {
  const cookie = getCookie(c, COOKIE)
  deleteCookie(c, COOKIE, { path: CALLBACK[provider], secure: true })
  const [nonce, verifier] = cookie?.split('.') ?? []
  try {
    const { payload } = await jwtVerify(state, stateKey(env), { algorithms: ['HS256'] })
    if (!payload.sub || payload.n !== nonce || !verifier) return { error: 'state_mismatch' }
    return { userId: payload.sub, verifier, admin: payload.a === 1 }
  } catch {
    return { error: 'state_invalid' }
  }
}

/** Routes that need a signed-in user (mounted behind requireUser). */
export function accountRoutes(env: Env, deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  // Step 1: the web app calls this, then navigates to the returned Google URL.
  app.post('/accounts/connect/gmail', async (c) => {
    const { state, codeChallenge } = await beginOAuth(c, env, 'gmail', c.get('user').id)
    const url = buildAuthUrl(googleOAuth(env), {
      state,
      codeChallenge,
      loginHint: c.req.query('hint'),
    })
    return c.json({ url })
  })

  /**
   * Same for Microsoft 365 / Outlook.com. `?admin=1` asks for tenant-wide admin consent
   * first, for work tenants (GoDaddy-managed ones among them) where users can't approve apps;
   * the callback then carries straight on into the normal sign-in.
   */
  app.post('/accounts/connect/graph', async (c) => {
    const admin = c.req.query('admin') === '1'
    const { state, codeChallenge } = await beginOAuth(c, env, 'graph', c.get('user').id, admin)
    const cfg = microsoftOAuth(env)
    const url = admin
      ? buildAdminConsentUrl(cfg, { state, tenant: c.req.query('tenant') })
      : buildMicrosoftAuthUrl(cfg, { state, codeChallenge, loginHint: c.req.query('hint') })
    return c.json({ url })
  })

  app.post('/accounts/:id/sync', async (c) => {
    const user = c.get('user')
    const [row] = await deps
      .db()
      .query<{ id: string }>(`SELECT id FROM accounts WHERE id = $1 AND user_id = $2`, [
        c.req.param('id'),
        user.id,
      ])
    if (!row) throw new HTTPException(404, { message: 'No such account' })
    await enqueueSync(deps.db(), user.id, row.id)
    return c.body(null, 202)
  })

  return app
}

/**
 * Step 2: the provider redirects the browser here. Authenticated by the signed state +
 * cookie, since the session token isn't sent on a top-level redirect.
 */
export function oauthCallbackRoute(env: Env, deps: Deps) {
  const app = new Hono()
  const fail = (c: Context, reason: string, provider: Provider) =>
    c.redirect(
      `/?connect_error=${encodeURIComponent(reason)}${provider === 'gmail' ? '' : `&provider=${provider}`}`,
      302,
    )

  app.get('/accounts/callback/gmail', async (c) => {
    const { code, state, error } = c.req.query()
    if (error) return fail(c, error, 'gmail')
    if (!code || !state) return fail(c, 'missing_code', 'gmail')
    const s = await finishOAuth(c, env, 'gmail', state)
    if (!s.userId) return fail(c, s.error ?? 'state_invalid', 'gmail')

    const tokens = await exchangeCode(googleOAuth(env), code, s.verifier, deps.fetch)
    if (!tokens.refreshToken) return fail(c, 'no_refresh_token', 'gmail')

    const gmail = new GmailProvider({
      fetch: deps.fetch,
      tokens: { getAccessToken: async () => tokens.accessToken },
    })
    const profile = await gmail.profile()
    await connectAccount(deps, {
      userId: s.userId,
      provider: 'gmail',
      email: profile.emailAddress,
      name: profile.emailAddress,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
    })
    return c.redirect(`/?connected=${encodeURIComponent(profile.emailAddress)}`, 302)
  })

  app.get('/accounts/callback/graph', async (c) => {
    const q = c.req.query()
    if (!q.state) return fail(c, q.error ?? 'missing_code', 'graph')
    const s = await finishOAuth(c, env, 'graph', q.state)
    if (!s.userId) return fail(c, s.error ?? 'state_invalid', 'graph')

    if (s.admin) {
      // Back from tenant-wide consent: on success, go straight on to signing in.
      if (q.error || q.admin_consent?.toLowerCase() !== 'true')
        return fail(c, q.error ?? 'admin_consent_denied', 'graph')
      const { state, codeChallenge } = await beginOAuth(c, env, 'graph', s.userId)
      return c.redirect(buildMicrosoftAuthUrl(microsoftOAuth(env), { state, codeChallenge }), 302)
    }

    if (q.error) {
      // The tenant doesn't let users approve apps: offer the admin consent step instead.
      const needsAdmin =
        q.error === 'consent_required' ||
        /AADSTS(65001|90094|90095|900941)\b/.test(q.error_description ?? '')
      return fail(c, needsAdmin ? 'admin_consent_required' : q.error, 'graph')
    }
    if (!q.code) return fail(c, 'missing_code', 'graph')

    const tokens = await exchangeMicrosoftCode(microsoftOAuth(env), q.code, s.verifier, deps.fetch)
    if (!tokens.refreshToken) return fail(c, 'no_refresh_token', 'graph')
    const profile = await new GraphProvider({
      fetch: deps.fetch,
      tokens: { getAccessToken: async () => tokens.accessToken },
    }).profile()
    await connectAccount(deps, {
      userId: s.userId,
      provider: 'graph',
      email: profile.email,
      name: profile.name ?? profile.email,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
    })
    return c.redirect(`/?connected=${encodeURIComponent(profile.email)}`, 302)
  })
  return app
}

/** Creates or revives the account, stores its refresh token and starts the first sync. */
async function connectAccount(
  deps: Deps,
  a: {
    userId: string
    provider: Provider
    email: string
    name: string
    refreshToken: string
    scope: string
  },
) {
  const db: Db = deps.db()
  const [account] = await db.query<{ id: string }>(
    `INSERT INTO accounts (user_id, provider, email, display_name, color, status)
     VALUES ($1, $2, lower($3), $4,
       (SELECT count(*)::int FROM accounts WHERE user_id = $1), 'connecting')
     ON CONFLICT (user_id, provider, email) DO UPDATE SET status = 'connecting', last_error = NULL
     RETURNING id`,
    [a.userId, a.provider, a.email, a.name],
  )
  await saveCredentials(db, await deps.providers().encryptionKey(), {
    accountId: account!.id,
    userId: a.userId,
    secret: { refreshToken: a.refreshToken },
    scopes: a.scope.split(' '),
  })
  await enqueueInitialSync(db, a.userId, account!.id)
}

const stateKey = (env: Env) => new TextEncoder().encode(required(env, 'OAUTH_STATE_SECRET'))

const googleOAuth = (env: Env) => ({
  clientId: required(env, 'GOOGLE_CLIENT_ID'),
  clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
  redirectUri: `${env.APP_ORIGIN}${CALLBACK.gmail}`,
})

const microsoftOAuth = (env: Env) => ({
  clientId: required(env, 'MICROSOFT_CLIENT_ID'),
  clientSecret: required(env, 'MICROSOFT_CLIENT_SECRET'),
  tenant: env.MICROSOFT_TENANT,
  redirectUri: `${env.APP_ORIGIN}${CALLBACK.graph}`,
})
