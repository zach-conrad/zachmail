import { enqueueSync, enqueueWatchNow, graphClientState } from '@zachmail/engine'
import { Hono } from 'hono'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { timingSafeEqual } from 'node:crypto'
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

  /**
   * Graph change notifications and lifecycle events for Outlook accounts. Graph first proves
   * the endpoint with a validationToken to echo; each notification then carries the
   * subscription id and the per-account clientState we registered, which is what we trust.
   */
  app.post('/graph', async (c) => {
    const validationToken = c.req.query('validationToken')
    if (validationToken !== undefined)
      return c.text(validationToken, 200, { 'content-type': 'text/plain' })

    const secret = env.GRAPH_WEBHOOK_SECRET
    if (!secret) return c.body(null, 503)
    let notes: { subscriptionId?: string; clientState?: string; lifecycleEvent?: string }[]
    try {
      notes = (await c.req.json<{ value?: typeof notes }>()).value ?? []
    } catch {
      return c.body(null, 202) // malformed: ack so it isn't redelivered forever
    }

    const db = deps.db()
    const subs = [...new Set(notes.map((n) => n.subscriptionId).filter((s) => !!s))]
    if (!subs.length) return c.body(null, 202)
    const accounts = await db.query<{ id: string; user_id: string; sub: string }>(
      `SELECT id, user_id, sync_state->>'subscriptionId' AS sub FROM accounts
       WHERE provider = 'graph' AND status <> 'disabled' AND sync_state->>'subscriptionId' = ANY($1::text[])`,
      [subs],
    )
    const done = new Set<string>()
    for (const n of notes) {
      const a = accounts.find((x) => x.sub === n.subscriptionId)
      if (!a || !sameSecret(n.clientState, graphClientState(secret, a.id))) continue
      const key = `${a.id}:${n.lifecycleEvent ?? 'change'}`
      if (done.has(key)) continue
      done.add(key)
      if (
        n.lifecycleEvent === 'reauthorizationRequired' ||
        n.lifecycleEvent === 'subscriptionRemoved'
      )
        await enqueueWatchNow(db, a.user_id, a.id)
      // 'missed' and plain changes alike: sync; the delta finds what changed.
      if (n.lifecycleEvent !== 'reauthorizationRequired') await enqueueSync(db, a.user_id, a.id)
    }
    return c.body(null, 202)
  })

  return app
}

const sameSecret = (got: string | undefined, want: string) =>
  !!got && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want))
