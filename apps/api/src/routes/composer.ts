import { InvalidSnippetError, parseSnippetInput } from '@zachmail/core'
import {
  SnippetConflictError,
  deleteSnippet,
  dismissNudges,
  nudge,
  restoreNudges,
  upsertSnippet,
} from '@zachmail/db/server'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_THREADS = 1000

/** Snippets and follow-up nudge dismissals. Clients apply both locally first; these persist. */
export function composerRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  const idParam = (id: string) => {
    if (!UUID.test(id)) throw new HTTPException(400, { message: 'id must be a UUID' })
    return id
  }

  app.put('/snippets/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    let input
    try {
      input = parseSnippetInput(await c.req.json())
    } catch (err) {
      if (err instanceof InvalidSnippetError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const userId = c.get('user').id
    const db = deps.db()
    try {
      if (!(await upsertSnippet(db, userId, id, input)))
        throw new HTTPException(404, { message: 'No such snippet' })
    } catch (err) {
      if (err instanceof SnippetConflictError)
        throw new HTTPException(409, { message: err.message })
      throw err
    }
    await nudge(db, userId)
    return c.json({ id })
  })

  app.delete('/snippets/:id', async (c) => {
    const id = idParam(c.req.param('id'))
    const userId = c.get('user').id
    const db = deps.db()
    await deleteSnippet(db, userId, id)
    await nudge(db, userId)
    return c.body(null, 204)
  })

  const threadIds = async (body: Promise<unknown>) => {
    let ids: unknown
    try {
      ids = ((await body) as { threadIds?: unknown } | null)?.threadIds
    } catch {
      ids = undefined
    }
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > MAX_THREADS ||
      !ids.every((x) => typeof x === 'string' && UUID.test(x))
    )
      throw new HTTPException(400, { message: `threadIds must be 1-${MAX_THREADS} UUIDs` })
    return ids as string[]
  }

  /** Hides follow-up nudges until each thread gets a newer message. */
  app.post('/nudges/dismiss', async (c) => {
    const ids = await threadIds(c.req.json())
    const userId = c.get('user').id
    const db = deps.db()
    const dismissed = await dismissNudges(db, userId, ids)
    if (dismissed.length) await nudge(db, userId)
    return c.json({ dismissed })
  })

  /** Undo of dismiss. */
  app.post('/nudges/restore', async (c) => {
    const ids = await threadIds(c.req.json())
    const userId = c.get('user').id
    const db = deps.db()
    await restoreNudges(db, userId, ids)
    await nudge(db, userId)
    return c.body(null, 204)
  })

  return app
}
