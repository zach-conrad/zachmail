import { BadCursorError, searchMail } from '@zachhub/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v))

export function searchRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  /** Mirror search, then provider fallback page by page (see SearchResponse in core). */
  app.get('/search', async (c) => {
    const q = c.req.query('q') ?? ''
    const limit = num(c.req.query('limit'))
    const olderThan = num(c.req.query('olderThan'))
    const tz = num(c.req.query('tz'))
    if (q.length > 1000) throw new HTTPException(400, { message: 'Query too long' })
    for (const v of [limit, olderThan, tz])
      if (v !== undefined && !Number.isFinite(v))
        throw new HTTPException(400, { message: 'Bad number' })
    if (tz !== undefined && Math.abs(tz) > 14 * 60)
      throw new HTTPException(400, { message: 'Bad tz' })
    try {
      const r = await searchMail(deps.db(), deps.providers(), c.get('user').id, {
        q,
        limit,
        olderThan,
        tzOffset: tz,
        cursor: c.req.query('cursor') || null,
      })
      c.header('cache-control', 'no-store')
      return c.json(r)
    } catch (err) {
      if (err instanceof BadCursorError) throw new HTTPException(400, { message: err.message })
      throw err
    }
  })

  return app
}
