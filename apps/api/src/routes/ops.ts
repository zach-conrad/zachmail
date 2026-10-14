import { InvalidOpsError, parseOpsRequest, type OpsResponse } from '@zachmail/core'
import { acceptOps, nudge } from '@zachmail/db/server'
import { enqueueOutboxFlush } from '@zachmail/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

export function opsRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  /** Triage ops from a client's pending queue. Safe to retry: op ids are idempotency keys. */
  app.post('/ops', async (c) => {
    const userId = c.get('user').id
    let ops
    try {
      ops = parseOpsRequest(await c.req.json()).ops
    } catch (err) {
      if (err instanceof InvalidOpsError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const db = deps.db()
    const { accepted, rejected, accounts } = await acceptOps(db, userId, ops)
    for (const accountId of accounts) await enqueueOutboxFlush(db, userId, accountId)
    if (accepted.length) await nudge(db, userId)
    return c.json({ accepted, rejected } satisfies OpsResponse)
  })

  return app
}
