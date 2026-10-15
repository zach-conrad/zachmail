/**
 * Remote MCP server (Streamable HTTP, stateless, JSON responses) at /api/mcp. Hand-rolled
 * because a tools-only server is a few JSON-RPC methods, and skipping the SDK keeps the
 * function bundle and its cold start small.
 */
import { Hono } from 'hono'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'
import type { Env } from '../env'
import { requireMcpToken, type McpOAuth } from './oauth'
import { TOOLS, ToolError, callTool } from './tools'

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = `ZachMail is Zach's own mail client; these tools reach every account he has connected.
Use search_threads to find mail and get_thread to read it. Ids come from earlier results; never invent them.
Triage and label changes sync to the provider and every device right away.
Prefer save_draft for anything Zach should review; only use send_email when he clearly asked to send.`

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

const ok = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const err = (id: RpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
})

export function mcpRoutes(env: Env, deps: Deps, oauth: McpOAuth | null) {
  const app = new Hono<{ Variables: AuthVariables }>()
  app.use('*', requireMcpToken(oauth))

  app.post('/', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json(err(null, -32700, 'Parse error'), 400)
    }
    const userId = c.get('user').id
    const batch = Array.isArray(body)
    const requests = (batch ? body : [body]) as RpcRequest[]
    const replies = (await Promise.all(requests.map((r) => handle(env, deps, userId, r)))).filter(
      (r) => r !== null,
    )
    // Only notifications: nothing to answer.
    if (!replies.length) return c.body(null, 202)
    return c.json(batch ? replies : replies[0])
  })

  // No server-initiated stream and no sessions to end.
  app.on(['GET', 'DELETE'], '/', (c) => c.body(null, 405, { allow: 'POST' }))
  return app
}

async function handle(env: Env, deps: Deps, userId: string, req: RpcRequest) {
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string')
    return err(req?.id, -32600, 'Invalid request')
  const isNotification = req.id === undefined
  if (isNotification) return null

  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion
      return ok(req.id, {
        protocolVersion:
          typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'zachmail', title: 'ZachMail', version: env.GIT_SHA ?? 'dev' },
        instructions: INSTRUCTIONS,
      })
    }
    case 'ping':
      return ok(req.id, {})
    case 'tools/list':
      return ok(req.id, { tools: TOOLS })
    case 'tools/call': {
      const name = req.params?.name
      if (typeof name !== 'string') return err(req.id, -32602, 'Missing tool name')
      if (!TOOLS.some((t) => t.name === name)) return err(req.id, -32602, `Unknown tool: ${name}`)
      try {
        const result = await callTool(
          deps,
          userId,
          name,
          (req.params?.arguments ?? {}) as Record<string, unknown>,
        )
        return ok(req.id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        })
      } catch (e) {
        if (!(e instanceof ToolError)) console.error('mcp tool', name, e)
        const message = e instanceof ToolError ? e.message : 'Something went wrong on the server'
        return ok(req.id, { content: [{ type: 'text', text: message }], isError: true })
      }
    }
    default:
      return err(req.id, -32601, `Method not found: ${req.method}`)
  }
}
