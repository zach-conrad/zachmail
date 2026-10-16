import type { BootstrapLine } from '@zachhub/core'
import { readBootstrap, readContacts, readDelta } from '@zachhub/db/server'
import { getMessageBody } from '@zachhub/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function syncRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  /** Initial replica as NDJSON, gzip-streamed so the client can apply chunks as they land. */
  app.get('/bootstrap', (c) => {
    const userId = c.get('user').id
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 90) || 90, 1), 3650)
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (line: BootstrapLine) =>
          controller.enqueue(enc.encode(JSON.stringify(line) + '\n'))
        try {
          const seq = await readBootstrap(deps.db(), userId, days, (rows) => write({ rows }))
          write({ seq })
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })
    const gzip = /\bgzip\b/.test(c.req.header('accept-encoding') ?? '')
    return new Response(gzip ? body.pipeThrough(new CompressionStream('gzip')) : body, {
      headers: {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      },
    })
  })

  app.get('/sync', async (c) => {
    const since = Number(c.req.query('since') ?? 0)
    if (!Number.isFinite(since) || since < 0) throw new HTTPException(400, { message: 'Bad since' })
    const delta = await readDelta(deps.db(), c.get('user').id, since)
    c.header('cache-control', 'no-store')
    return c.json(delta)
  })

  app.get('/messages/:id/body', async (c) => {
    const id = c.req.param('id')
    if (!UUID.test(id)) throw new HTTPException(400, { message: 'Bad id' })
    const r = await getMessageBody(
      deps.db(),
      deps.providers(),
      deps.engineConfig().imageProxySecret,
      c.get('user').id,
      id,
    )
    if (!r) throw new HTTPException(404, { message: 'Not found' })
    c.header('cache-control', 'private, max-age=86400')
    return c.json(r.body)
  })

  /** Autocomplete source; clients cache the whole list and match locally. */
  app.get('/contacts', async (c) => {
    const contacts = await readContacts(deps.db(), c.get('user').id)
    c.header('cache-control', 'private, max-age=300')
    return c.json({ contacts })
  })

  return app
}
