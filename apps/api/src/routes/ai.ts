import type { AssistInput } from '@zachhub/ai'
import {
  InvalidAssistError,
  parseAssistRequest,
  type AssistEvent,
  type AssistRequest,
} from '@zachhub/core'
import { threadForAssist } from '@zachhub/engine'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

export function aiRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  /**
   * Writing help for the composer: draft / rewrite / summarize, streamed as NDJSON
   * AssistEvents so the first words show while Claude is still writing. Closing the request
   * stops generation.
   */
  app.post('/ai/assist', async (c) => {
    const ai = await deps.ai()
    if (!ai) throw new HTTPException(503, { message: 'AI is not set up' })
    let req: AssistRequest
    try {
      req = parseAssistRequest(await c.req.json())
    } catch (err) {
      if (err instanceof InvalidAssistError || err instanceof SyntaxError)
        throw new HTTPException(400, { message: err.message })
      throw err
    }
    const user = c.get('user')
    const input = await assistInput(deps, user, req)

    const { streamAssist, AssistDeclinedError } = await import('@zachhub/ai')
    const abort = new AbortController()
    c.req.raw.signal.addEventListener('abort', () => abort.abort())
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (ev: AssistEvent) => controller.enqueue(enc.encode(JSON.stringify(ev) + '\n'))
        try {
          const gen = streamAssist(ai, input, abort.signal)
          let r = await gen.next()
          while (!r.done) {
            write({ type: 'text', text: r.value })
            r = await gen.next()
          }
          write({ type: 'done', truncated: r.value.truncated })
        } catch (err) {
          if (abort.signal.aborted) return
          if (!(err instanceof AssistDeclinedError)) console.error('assist failed', err)
          write({
            type: 'error',
            message:
              err instanceof AssistDeclinedError ? err.message : 'Claude is unavailable right now',
          })
        }
        controller.close()
      },
      cancel() {
        abort.abort()
      },
    })
    return new Response(body, {
      headers: {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    })
  })

  return app
}

async function assistInput(
  deps: Deps,
  user: { id: string; email: string },
  req: AssistRequest,
): Promise<AssistInput> {
  const base = { mode: req.mode, instruction: req.instruction, text: req.text }
  const db = deps.db()
  if (req.threadId && req.mode !== 'rewrite') {
    const t = await threadForAssist(
      db,
      deps.providers(),
      deps.engineConfig().imageProxySecret,
      user.id,
      req.threadId,
    )
    if (!t) throw new HTTPException(404, { message: 'No such thread' })
    return { ...base, me: t.thread.me[0]!, subject: t.thread.subject, thread: t.messages }
  }
  if (req.accountId) {
    const [a] = await db.query<{ email: string; display_name: string | null }>(
      `SELECT email, display_name FROM accounts WHERE id = $1 AND user_id = $2`,
      [req.accountId, user.id],
    )
    if (!a) throw new HTTPException(404, { message: 'No such account' })
    return { ...base, me: { email: a.email, ...(a.display_name ? { name: a.display_name } : {}) } }
  }
  return { ...base, me: { email: user.email } }
}
