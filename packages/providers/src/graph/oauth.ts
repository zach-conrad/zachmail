import type { FetchLike } from '../types'

/**
 * Delegated scopes. offline_access yields a refresh token; MailboxSettings.Read is for
 * send-as aliases and the signature later.
 */
export const GRAPH_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxSettings.Read',
]

export interface MicrosoftOAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  /**
   * 'common' (default) accepts work/school and personal accounts. A work tenant's id or
   * domain pins sign-in to that tenant.
   */
  tenant?: string
}

const authority = (tenant?: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'common')}/oauth2/v2.0`

/**
 * The Microsoft sign-in URL. Federated tenants (GoDaddy-managed Microsoft 365, Okta, ADFS)
 * need nothing special: Microsoft sends the browser on to the federation's own login page
 * after the user types their address, or straight away when `loginHint` is given.
 */
export function buildMicrosoftAuthUrl(
  cfg: MicrosoftOAuthConfig,
  opts: { state: string; codeChallenge: string; loginHint?: string },
) {
  const u = new URL(`${authority(cfg.tenant)}/authorize`)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('response_mode', 'query')
  u.searchParams.set('scope', GRAPH_SCOPES.join(' '))
  u.searchParams.set('state', opts.state)
  u.searchParams.set('code_challenge', opts.codeChallenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('prompt', 'select_account')
  if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint)
  return u.toString()
}

/**
 * Admin consent for the whole tenant, for tenants that don't let users approve apps
 * themselves ("Need admin approval"). A tenant admin signs in and approves once; Microsoft
 * then redirects to `redirectUri` with `admin_consent=True` and the tenant id.
 */
export function buildAdminConsentUrl(
  cfg: MicrosoftOAuthConfig,
  opts: { state: string; tenant?: string },
) {
  // 'common' can't take admin consent; 'organizations' lets Microsoft find the admin's tenant.
  const tenant =
    opts.tenant || (cfg.tenant && cfg.tenant !== 'common' ? cfg.tenant : 'organizations')
  const u = new URL(
    `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/adminconsent`,
  )
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set(
    'scope',
    GRAPH_SCOPES.filter((s) => /^[A-Z]/.test(s))
      .map((s) => `https://graph.microsoft.com/${s}`)
      .join(' '),
  )
  u.searchParams.set('state', opts.state)
  return u.toString()
}

export interface MicrosoftTokens {
  accessToken: string
  expiresAt: Date
  /** Microsoft rotates refresh tokens: store the new one whenever it is returned. */
  refreshToken?: string
  scope: string
  idToken?: string
}

/** Token errors that mean the grant is gone and Zach must sign in again. */
const REAUTH_ERRORS = new Set(['invalid_grant', 'interaction_required', 'consent_required'])

export class MicrosoftTokenError extends Error {
  override name = 'MicrosoftTokenError'
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message)
  }
  get needsReauth() {
    return !!this.code && REAUTH_ERRORS.has(this.code)
  }
}

async function tokenRequest(
  tenant: string | undefined,
  params: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<MicrosoftTokens> {
  const res = await fetchImpl(`${authority(tenant)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ scope: GRAPH_SCOPES.join(' '), ...params }).toString(),
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
    // error_description starts with the AADSTS code, e.g. AADSTS65001 (consent missing).
    throw new MicrosoftTokenError(
      `Microsoft token error: ${j.error ?? res.status} ${j.error_description?.split('\r\n')[0] ?? ''}`.trim(),
      j.error,
    )
  }
  return {
    accessToken: j.access_token,
    expiresAt: new Date(Date.now() + (j.expires_in ?? 3600) * 1000),
    refreshToken: j.refresh_token,
    scope: j.scope ?? '',
    idToken: j.id_token,
  }
}

export function exchangeMicrosoftCode(
  cfg: MicrosoftOAuthConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: FetchLike = fetch,
) {
  return tokenRequest(
    cfg.tenant,
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

export function refreshMicrosoftToken(
  cfg: Pick<MicrosoftOAuthConfig, 'clientId' | 'clientSecret' | 'tenant'>,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
) {
  return tokenRequest(
    cfg.tenant,
    {
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'refresh_token',
    },
    fetchImpl,
  )
}
