import { ResyncRequired, type SyncTransport } from './client'
import type { OpsRequest, OpsResponse } from './ops'
import type { ContactRow, DraftRequest, SendRequest, SendResponse } from './send'
import type { BootstrapLine, MessageBody, SyncDelta } from './protocol'

export interface HttpTransportOptions {
  /** API origin; '' for same-origin. */
  baseUrl?: string
  /** Current Supabase access token (re-read per request so refreshes apply). */
  token: () => string | null | Promise<string | null>
  fetch?: typeof fetch
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    /** The server's own message, when it sent one; safe to show. */
    readonly detail: string | null = null,
  ) {
    super(detail ?? `${path} failed with HTTP ${status}`)
  }
}

async function errorMessage(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).trim()
    if (!text) return null
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown }
      const m = j.error ?? j.message
      return typeof m === 'string' ? m : null
    } catch {
      return text.length <= 200 && !text.startsWith('<') ? text : null
    }
  } catch {
    return null
  }
}

/** The client side of the wire contract in protocol.ts. */
export function httpTransport(opts: HttpTransportOptions): SyncTransport & {
  body(messageId: string, signal?: AbortSignal): Promise<MessageBody>
  ops(req: OpsRequest, signal?: AbortSignal): Promise<OpsResponse>
  send(req: SendRequest): Promise<SendResponse>
  /** Undo send: true when cancelled, false when it is already on its way (409). */
  unsend(id: string): Promise<boolean>
  saveDraft(id: string, draft: DraftRequest): Promise<void>
  deleteDraft(id: string): Promise<void>
  contacts(): Promise<ContactRow[]>
} {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = opts.baseUrl ?? ''

  async function request(
    method: string,
    path: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<Response> {
    const token = await opts.token()
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await f(base + path, {
      method,
      signal,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    if (res.status === 410) throw new ResyncRequired()
    if (!res.ok) throw new HttpError(res.status, path, await errorMessage(res))
    return res
  }
  const get = (path: string, signal?: AbortSignal) => request('GET', path, signal)
  const post = (path: string, body: unknown, signal?: AbortSignal) =>
    request('POST', path, signal, body)

  return {
    async *bootstrap(signal) {
      const res = await get('/api/bootstrap', signal)
      yield* readNdjson<BootstrapLine>(res.body!)
    },
    async delta(since, signal) {
      return (await (await get(`/api/sync?since=${since}`, signal)).json()) as SyncDelta
    },
    async body(messageId, signal) {
      const path = `/api/messages/${encodeURIComponent(messageId)}/body`
      return (await (await get(path, signal)).json()) as MessageBody
    },
    async ops(req, signal) {
      return (await (await post('/api/ops', req, signal)).json()) as OpsResponse
    },
    async send(req) {
      return (await (await post('/api/send', req)).json()) as SendResponse
    },
    async unsend(id) {
      try {
        await request('DELETE', `/api/send/${encodeURIComponent(id)}`)
        return true
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) return false
        throw err
      }
    },
    async saveDraft(id, draft) {
      await request('PUT', `/api/drafts/${encodeURIComponent(id)}`, undefined, draft)
    },
    async deleteDraft(id) {
      try {
        await request('DELETE', `/api/drafts/${encodeURIComponent(id)}`)
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err
      }
    },
    async contacts() {
      return ((await (await get('/api/contacts')).json()) as { contacts: ContactRow[] }).contacts
    },
  }
}

/** Parses a newline-delimited JSON byte stream, one value per line, as it arrives. */
export async function* readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) yield JSON.parse(line) as T
      }
      if (done) break
    }
    if (buf.trim()) yield JSON.parse(buf) as T
  } finally {
    reader.releaseLock()
  }
}
