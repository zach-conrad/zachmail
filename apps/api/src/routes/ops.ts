import {
  InvalidOpsError,
  InvalidSendError,
  parseDraftRequest,
  parseOpsRequest,
  parseSendRequest,
  type OpsResponse,
  type SendResponse,
} from '@zachmail/core'
import {
  SendRejectedError,
  acceptOps,
  acceptSend,
  cancelSend,
  deleteDraft,
  nudge,
  saveDraft,
} from '@zachmail/db/server'
import { enqueueDraftSync, enqueueOutboxFlush } from '@zachmail/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  /** Queues a message; the worker sends it once the undo window (or `sendAt`) has passed. */
  app.post('/send', async (c) => {
    const userId = c.get('user').id
    let req
    try {
      req = parseSendRequest(await c.req.json())
    } catch (err) {
      if (err instanceof InvalidSendError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const db = deps.db()
    let sendAt: number
    try {
      sendAt = await acceptSend(db, userId, req)
    } catch (err) {
      if (err instanceof SendRejectedError) throw new HTTPException(422, { message: err.message })
      throw err
    }
    await enqueueOutboxFlush(db, userId, req.accountId, new Date(sendAt))
    return c.json({ id: req.id, sendAt } satisfies SendResponse, 202)
  })

  /** Undo send. 409 once the worker has started sending (or it already went). */
  app.delete('/send/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID.test(id)) throw new HTTPException(400, { message: 'id must be a UUID' })
    const undone = await cancelSend(deps.db(), c.get('user').id, id)
    if (!undone) throw new HTTPException(409, { message: 'Already sent' })
    return c.json({ undone: true })
  })

  /** Draft autosave. Clients PUT the whole draft; the provider copy follows after a pause. */
  app.put('/drafts/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID.test(id)) throw new HTTPException(400, { message: 'id must be a UUID' })
    let req
    try {
      req = parseDraftRequest(await c.req.json())
    } catch (err) {
      if (err instanceof InvalidSendError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const userId = c.get('user').id
    const db = deps.db()
    const version = await saveDraft(db, userId, id, req)
    if (version === null) throw new HTTPException(422, { message: 'No such account' })
    await enqueueDraftSync(db, userId, id, true)
    return c.json({ id, version }, 202)
  })

  app.delete('/drafts/:id', async (c) => {
    const id = c.req.param('id')
    if (!UUID.test(id)) throw new HTTPException(400, { message: 'id must be a UUID' })
    const userId = c.get('user').id
    const db = deps.db()
    if (!(await deleteDraft(db, userId, id)))
      throw new HTTPException(404, { message: 'No such draft' })
    await enqueueDraftSync(db, userId, id)
    return c.body(null, 204)
  })

  return app
}
