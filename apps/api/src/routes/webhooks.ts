import { enqueueSync } from '@zachmail/engine'
import { Hono } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Deps } from '../deps'
import { required, type Env } from '../env'

/**
 * Gmail → Pub/Sub → here. The push carries only {emailAddress, historyId}; we verify the
 * OIDC token Pub/Sub attaches, then enqueue a coalesced sync job. Always ack quickly: the
 * worker does the real work, and a non-2xx makes Pub/Sub redeliver.
 */
export function webhookRoutes(env: Env, deps: Deps) {
  const app = new Hono()
  let googleKeys = deps.googleKeys

  app.post('/gmail', async (c) => {
    const token = c.req.header('authorization')?.replace(/^Bearer /, '')
    if (!token) return c.body(null, 401)
    try {
      googleKeys ??= createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'))
      const { payload } = await jwtVerify(token, googleKeys, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: required(env, 'GMAIL_PUSH_AUDIENCE'),
      })
      if (
        payload.email !== required(env, 'GMAIL_PUSH_SERVICE_ACCOUNT') ||
        payload.email_verified !== true
      ) {
        return c.body(null, 403)
      }
    } catch {
      return c.body(null, 401)
    }

    let email: string | undefined
    try {
      const body = await c.req.json<{ message?: { data?: string } }>()
      const data = JSON.parse(Buffer.from(body.message?.data ?? '', 'base64').toString('utf8')) as {
        emailAddress?: string
      }
      email = data.emailAddress?.toLowerCase()
    } catch {
      return c.body(null, 204) // malformed push: ack so it isn't redelivered forever
    }
    if (!email) return c.body(null, 204)

    const db = deps.db()
    const accounts = await db.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM accounts WHERE provider = 'gmail' AND email = $1 AND status <> 'disabled'`,
      [email],
    )
    for (const a of accounts) await enqueueSync(db, a.user_id, a.id)
    return c.body(null, 204)
  })

  return app
}
