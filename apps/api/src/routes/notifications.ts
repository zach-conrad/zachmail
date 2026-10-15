import { InvalidNotificationSettingsError, parseNotificationSettings } from '@zachmail/core'
import {
  deleteDevice,
  readNotificationSettings,
  saveNotificationSettings,
  upsertDevice,
} from '@zachmail/db/server'
import { enqueueTestNotification } from '@zachmail/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'
import type { Env } from '../env'

const bad = (message: string) => new HTTPException(400, { message })

async function body(c: { req: { json(): Promise<unknown> } }) {
  try {
    return (await c.req.json()) as Record<string, unknown>
  } catch {
    throw bad('Body must be JSON')
  }
}

/** A browser PushSubscription as `subscription.toJSON()` serializes it. */
function parseSubscription(v: unknown) {
  const s = (v ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (
    typeof s.endpoint !== 'string' ||
    !/^https:\/\/\S+$/.test(s.endpoint) ||
    s.endpoint.length > 1024
  )
    throw bad('subscription.endpoint must be an https URL')
  const { p256dh, auth } = s.keys ?? {}
  if (
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    p256dh.length > 200 ||
    auth.length > 200
  )
    throw bad('subscription.keys must have p256dh and auth')
  return { endpoint: s.endpoint, keys: { p256dh, auth } }
}

/**
 * Push targets and notification rules. Sending happens in the worker (it owns the VAPID
 * private key); the API only hands out the public key and records subscriptions.
 */
export function notificationRoutes(env: Env, deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/push/key', (c) => {
    if (!env.VAPID_PUBLIC_KEY) throw new HTTPException(503, { message: 'Web Push is not set up' })
    return c.json({ key: env.VAPID_PUBLIC_KEY })
  })

  app.put('/devices', async (c) => {
    const b = await body(c)
    if (b.kind !== 'webpush') throw bad("kind must be 'webpush'")
    const sub = parseSubscription(b.subscription)
    const label = typeof b.label === 'string' ? b.label.slice(0, 120) : null
    const ok = await upsertDevice(deps.db(), c.get('user').id, {
      kind: 'webpush',
      token: sub.endpoint,
      keys: sub.keys,
      label,
    })
    if (!ok) throw new HTTPException(409, { message: 'Subscription belongs to another user' })
    return c.json({ ok: true })
  })

  app.delete('/devices', async (c) => {
    const b = await body(c)
    if (typeof b.token !== 'string') throw bad('token must be a string')
    await deleteDevice(deps.db(), c.get('user').id, b.token)
    return c.json({ deleted: true })
  })

  app.get('/notification-settings', async (c) =>
    c.json(await readNotificationSettings(deps.db(), c.get('user').id)),
  )

  app.put('/notification-settings', async (c) => {
    let settings
    try {
      settings = parseNotificationSettings(await body(c))
    } catch (err) {
      if (err instanceof InvalidNotificationSettingsError) throw bad(err.message)
      throw err
    }
    await saveNotificationSettings(deps.db(), c.get('user').id, settings)
    return c.json(settings)
  })

  app.post('/notifications/test', async (c) => {
    await enqueueTestNotification(deps.db(), c.get('user').id)
    return c.json({ queued: true }, 202)
  })

  return app
}
