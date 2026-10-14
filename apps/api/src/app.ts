import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { requireUser, type AuthVariables } from './auth'
import { buildDeps, type Deps } from './deps'
import type { Env } from './env'
import { accountRoutes, oauthCallbackRoute } from './routes/accounts'
import { imageRoutes } from './routes/images'
import { opsRoutes } from './routes/ops'
import { syncRoutes } from './routes/sync'
import { webhookRoutes } from './routes/webhooks'

export function createApp(env: Env, overrides: Partial<Deps> = {}) {
  const deps = buildDeps(env, overrides)
  const app = new Hono()

  // Public: health, the OAuth callback (signed state), signed image URLs, verified webhooks.
  const api = new Hono<{ Variables: AuthVariables }>()
  api.get('/health', (c) => c.json({ ok: true, sha: env.GIT_SHA ?? null }))
  api.route('/', oauthCallbackRoute(env, deps))
  api.route('/', imageRoutes(deps))

  // Everything else requires Zach's session.
  const authed = new Hono<{ Variables: AuthVariables }>()
  authed.use(
    '*',
    requireUser({
      supabaseUrl: env.SUPABASE_URL,
      allowedEmails: env.ALLOWED_EMAILS,
      keys: deps.supabaseKeys,
    }),
  )
  authed.get('/me', (c) => c.json(c.get('user')))
  authed.route('/', accountRoutes(env, deps))
  authed.route('/', syncRoutes(deps))
  authed.route('/', opsRoutes(deps))
  api.route('/', authed)

  app.route('/api', api)
  app.route('/webhooks', webhookRoutes(env, deps))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
