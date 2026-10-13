import type { FetchLike } from './api'

export const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.settings.basic',
]

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function buildAuthUrl(cfg: GoogleOAuthConfig, opts: { state: string; codeChallenge: string; loginHint?: string }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GMAIL_SCOPES.join(' '))
  // offline + consent guarantees a refresh token even when the account was connected before.
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('include_granted_scopes', 'true')
  u.searchParams.set('state', opts.state)
  u.searchParams.set('code_challenge', opts.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint)
  return u.toString()
}

export interface GoogleTokens {
  accessToken: string
  expiresAt: Date
  refreshToken?: string
  scope: string
  idToken?: string
}

async function tokenRequest(params: Record<string, string>, fetchImpl: FetchLike): Promise<GoogleTokens> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const j = (await res.json()) as {
    access_token?: string
    expires_in?: number
    refresh_token?: string
    scope?: string
    id_token?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !j.access_token) {
    const err = new Error(`Google token error: ${j.error ?? res.status} ${j.error_description ?? ''}`.trim())
    ;(err as Error & { code?: string }).code = j.error
    throw err
  }
  return {
    accessToken: j.access_token,
    expiresAt: new Date(Date.now() + (j.expires_in ?? 3600) * 1000),
    refreshToken: j.refresh_token,
    scope: j.scope ?? '',
    idToken: j.id_token,
  }
}

export function exchangeCode(cfg: GoogleOAuthConfig, code: string, codeVerifier: string, fetchImpl: FetchLike = fetch) {
  return tokenRequest(
    {
      code,
      code_verifier: codeVerifier,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  )
}

export function refreshAccessToken(
  cfg: Pick<GoogleOAuthConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
) {
  return tokenRequest(
    { refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' },
    fetchImpl,
  )
}
