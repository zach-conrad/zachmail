import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { JWTVerifyGetKey } from 'jose'
import { requireUser, type AuthVariables } from './auth'
import type { Env } from './env'

export function createApp(env: Env, deps: { keys?: JWTVerifyGetKey } = {}) {
  const app = new Hono<{ Variables: AuthVariables }>().basePath('/api')

  app.get('/health', (c) => c.json({ ok: true, sha: env.GIT_SHA ?? null }))

  const authed = app.use(
    '/*',
    requireUser({
      supabaseUrl: env.SUPABASE_URL,
      allowedEmails: env.ALLOWED_EMAILS,
      keys: deps.keys,
    }),
  )

  authed.get('/me', (c) => c.json(c.get('user')))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: 'Internal error' }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
