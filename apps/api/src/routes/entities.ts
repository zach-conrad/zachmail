import { InvalidEntityOpsError, parseEntityOpsRequest } from '@zachhub/core'
import { applyEntityOps, nudge } from '@zachhub/db/server'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

/** First-party entity writes for every module (core hub/entities.ts). Safe to retry. */
export function entityRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post('/entities', async (c) => {
    const userId = c.get('user').id
    let ops
    try {
      ops = parseEntityOpsRequest(await c.req.json()).ops
    } catch (err) {
      if (err instanceof InvalidEntityOpsError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const db = deps.db()
    const res = await db.transaction((tx) => applyEntityOps(tx, userId, deps.modules.entities, ops))
    if (res.accepted.length) await nudge(db, userId)
    return c.json(res)
  })

  return app
}
