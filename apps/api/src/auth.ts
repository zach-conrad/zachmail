import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export interface AuthUser {
  id: string
  email: string
}

export type AuthVariables = { user: AuthUser }

/**
 * Verifies the Supabase access token (asymmetric signing keys via JWKS, cached in memory) and
 * re-checks the email allowlist. Verification is local: no network hop per request once the
 * key set is cached.
 */
export function requireUser(opts: {
  supabaseUrl: string
  allowedEmails: string
  keys?: JWTVerifyGetKey
}) {
  const issuer = `${opts.supabaseUrl.replace(/\/$/, '')}/auth/v1`
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
  const allowed = new Set(
    opts.allowedEmails
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )

  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const header = c.req.header('authorization')
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token) throw new HTTPException(401, { message: 'Missing bearer token' })

    let payload
    try {
      ;({ payload } = await jwtVerify(token, keys, { issuer, audience: 'authenticated' }))
    } catch {
      throw new HTTPException(401, { message: 'Invalid token' })
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    if (!payload.sub || !allowed.has(email)) throw new HTTPException(403, { message: 'Forbidden' })

    c.set('user', { id: payload.sub, email })
    await next()
  })
}
