import { ResyncRequired, type SyncTransport } from './client'
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
  ) {
    super(`${path} failed with HTTP ${status}`)
  }
}

/** The client side of the wire contract in protocol.ts. */
export function httpTransport(opts: HttpTransportOptions): SyncTransport & {
  body(messageId: string, signal?: AbortSignal): Promise<MessageBody>
} {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = opts.baseUrl ?? ''

  async function get(path: string, signal?: AbortSignal): Promise<Response> {
    const token = await opts.token()
    const res = await f(base + path, {
      signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 410) throw new ResyncRequired()
    if (!res.ok) throw new HttpError(res.status, path)
    return res
  }

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
