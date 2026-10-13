import { enqueueInitialSync, enqueueSync } from '@zachmail/engine'
import { saveCredentials } from '@zachmail/db/server'
import { GmailProvider, buildAuthUrl, exchangeCode } from '@zachmail/providers/gmail'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { SignJWT, jwtVerify } from 'jose'
import { createHash, randomBytes } from 'node:crypto'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'
import { required, type Env } from '../env'

const COOKIE = 'zm_oauth'
const CALLBACK_PATH = '/api/accounts/callback/gmail'

const b64url = (b: Buffer) => b.toString('base64url')

/** Routes that need a signed-in user (mounted behind requireUser). */
export function accountRoutes(env: Env, deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  // Step 1: the web app calls this, then navigates to the returned Google URL.
  app.post('/accounts/connect/gmail', async (c) => {
    const verifier = b64url(randomBytes(32))
    const nonce = b64url(randomBytes(16))
    const state = await new SignJWT({ n: nonce })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(c.get('user').id)
      .setExpirationTime('10m')
      .sign(stateKey(env))
    setCookie(c, COOKIE, `${nonce}.${verifier}`, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: CALLBACK_PATH,
      maxAge: 600,
    })
    const url = buildAuthUrl(googleOAuth(env), {
      state,
      codeChallenge: b64url(createHash('sha256').update(verifier).digest()),
      loginHint: c.req.query('hint'),
    })
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

/** Step 2: Google redirects the browser here. Authenticated by the signed state + cookie. */
export function oauthCallbackRoute(env: Env, deps: Deps) {
  const app = new Hono()
  app.get('/accounts/callback/gmail', async (c) => {
    const fail = (reason: string) =>
      c.redirect(`/?connect_error=${encodeURIComponent(reason)}`, 302)
    const { code, state, error } = c.req.query()
    if (error) return fail(error)
    if (!code || !state) return fail('missing_code')

    const cookie = getCookie(c, COOKIE)
    deleteCookie(c, COOKIE, { path: CALLBACK_PATH, secure: true })
    const [nonce, verifier] = cookie?.split('.') ?? []
    let userId: string
    try {
      const { payload } = await jwtVerify(state, stateKey(env), { algorithms: ['HS256'] })
      if (!payload.sub || payload.n !== nonce || !verifier) return fail('state_mismatch')
      userId = payload.sub
    } catch {
      return fail('state_invalid')
    }

    const tokens = await exchangeCode(googleOAuth(env), code, verifier, deps.fetch)
    if (!tokens.refreshToken) return fail('no_refresh_token')

    const gmail = new GmailProvider({
      fetch: deps.fetch,
      tokens: { getAccessToken: async () => tokens.accessToken },
    })
    const profile = await gmail.profile()
    const db = deps.db()
    const [account] = await db.query<{ id: string }>(
      `INSERT INTO accounts (user_id, provider, email, display_name, color, status)
       VALUES ($1, 'gmail', lower($2), $2,
         (SELECT count(*)::int FROM accounts WHERE user_id = $1), 'connecting')
       ON CONFLICT (user_id, provider, email) DO UPDATE SET status = 'connecting', last_error = NULL
       RETURNING id`,
      [userId, profile.emailAddress],
    )
    await saveCredentials(db, await deps.providers().encryptionKey(), {
      accountId: account!.id,
      userId,
      secret: { refreshToken: tokens.refreshToken },
      scopes: tokens.scope.split(' '),
    })
    await enqueueInitialSync(db, userId, account!.id)
    return c.redirect(`/?connected=${encodeURIComponent(profile.emailAddress)}`, 302)
  })
  return app
}

const stateKey = (env: Env) => new TextEncoder().encode(required(env, 'OAUTH_STATE_SECRET'))

const googleOAuth = (env: Env) => ({
  clientId: required(env, 'GOOGLE_CLIENT_ID'),
  clientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
  redirectUri: `${env.APP_ORIGIN}${CALLBACK_PATH}`,
})
