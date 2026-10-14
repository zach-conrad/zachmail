import { InvalidSplitRuleError, SPLIT_RULE_LIMITS, isUuid, parseSplitRule } from '@zachmail/core'
import { deleteSplitRule, nudge, readSplitRules, upsertSplitRule } from '@zachmail/db/server'
import { enqueueResplit } from '@zachmail/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

/**
 * Split rules (ZachMail-only data). Clients apply edits to their replica first and send them
 * here from a pending queue, so both writes are idempotent by rule id.
 */
export function splitRuleRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/split-rules', async (c) => c.json(await readSplitRules(deps.db(), c.get('user').id)))

  app.put('/split-rules/:id', async (c) => {
    const userId = c.get('user').id
    let rule
    try {
      rule = parseSplitRule(c.req.param('id'), await c.req.json())
    } catch (err) {
      if (err instanceof InvalidSplitRuleError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const db = deps.db()
    const existing = await readSplitRules(db, userId)
    if (existing.length >= SPLIT_RULE_LIMITS.rules && !existing.some((r) => r.id === rule.id))
      throw new HTTPException(422, { message: 'Too many split rules' })
    if (!(await upsertSplitRule(db, userId, rule)))
      throw new HTTPException(409, { message: 'Rule id already in use' })
    await enqueueResplit(db, userId)
    await nudge(db, userId)
    return c.json(rule)
  })

  app.delete('/split-rules/:id', async (c) => {
    const id = c.req.param('id')
    if (!isUuid(id)) throw new HTTPException(400, { message: 'id must be a UUID' })
    const userId = c.get('user').id
    const db = deps.db()
    await deleteSplitRule(db, userId, id.toLowerCase())
    await enqueueResplit(db, userId)
    await nudge(db, userId)
    return c.json({ deleted: true })
  })

  return app
}
