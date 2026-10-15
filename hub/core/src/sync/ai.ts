/**
 * AI contracts. Triage runs in the worker after sync and reaches clients as `ThreadRow.ai`;
 * writing help is on demand: POST /api/ai/assist streams plain text into the composer.
 * The server answers 503 to every AI route while ANTHROPIC_API_KEY is unset.
 */

/** What triage decided a thread is. Split rules match on it (architecture §9). */
export const AI_CATEGORIES = [
  'important',
  'personal',
  'newsletter',
  'notification',
  'receipt',
  'calendar',
  'cold_outreach',
  'other',
] as const
export type AiCategory = (typeof AI_CATEGORIES)[number]

/** Triage result for a thread, as of its latest message. */
export interface ThreadAi {
  category: AiCategory
  /** One line, under ~120 characters. */
  summary: string
  /** The latest inbound message expects an answer from Zach. */
  needsReply: boolean
}

export type AssistMode = 'draft' | 'rewrite' | 'summarize'

/**
 * POST /api/ai/assist.
 * - `draft`: write a reply to `threadId` (or new mail when absent) following `instruction`;
 *   `text` is whatever is already in the composer.
 * - `rewrite`: rewrite `text` per `instruction` ("shorter", "friendlier"…).
 * - `summarize`: summarize `threadId`.
 * Text in and out is plain text with blank lines between paragraphs.
 */
export interface AssistRequest {
  mode: AssistMode
  threadId?: string
  /** Sending account for a new message; replies use the thread's account. */
  accountId?: string
  instruction?: string
  text?: string
}

/** The response body is NDJSON, one event per line, ending with `done` or `error`. */
export type AssistEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; truncated: boolean }
  | { type: 'error'; message: string }

export const MAX_ASSIST_TEXT = 50_000
export const MAX_ASSIST_INSTRUCTION = 2_000

export class InvalidAssistError extends Error {
  override name = 'InvalidAssistError'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseAssistRequest(body: unknown): AssistRequest {
  const fail = (msg: string): never => {
    throw new InvalidAssistError(msg)
  }
  if (!body || typeof body !== 'object') fail('body must be an object')
  const b = body as Record<string, unknown>
  const mode = b.mode
  if (mode !== 'draft' && mode !== 'rewrite' && mode !== 'summarize') fail('mode is invalid')
  const id = (k: 'threadId' | 'accountId') => {
    const v = b[k]
    if (v === undefined) return undefined
    if (typeof v !== 'string' || !UUID.test(v)) fail(`${k} must be a UUID`)
    return v as string
  }
  const str = (k: 'instruction' | 'text', max: number) => {
    const v = b[k]
    if (v === undefined) return undefined
    if (typeof v !== 'string' || v.length > max) fail(`${k} is invalid`)
    return (v as string).trim() || undefined
  }
  const req: AssistRequest = {
    mode: mode as AssistMode,
    threadId: id('threadId'),
    accountId: id('accountId'),
    instruction: str('instruction', MAX_ASSIST_INSTRUCTION),
    text: str('text', MAX_ASSIST_TEXT),
  }
  if (req.mode === 'summarize' && !req.threadId) fail('summarize needs threadId')
  if (req.mode === 'rewrite' && !req.text) fail('rewrite needs text')
  if (req.mode === 'draft' && !req.threadId && !req.instruction)
    fail('draft needs threadId or instruction')
  for (const k of Object.keys(req) as (keyof AssistRequest)[])
    if (req[k] === undefined) delete req[k]
  return req
}

/**
 * Reads an assist response body as it streams. Yields text chunks; throws on an `error`
 * event or a body that ends without `done` (connection dropped mid-draft).
 */
export async function* readAssistStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, { truncated: boolean }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      buf += dec.decode(value, { stream: !done })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const ev = JSON.parse(line) as AssistEvent
        if (ev.type === 'text') yield ev.text
        else if (ev.type === 'done') return { truncated: ev.truncated }
        else throw new Error(ev.message)
      }
      if (done) throw new Error('Assist stream ended early')
    }
  } finally {
    // Stops the download when the caller gives up early (e.g. the composer was closed).
    void reader.cancel().catch(() => {})
  }
}
