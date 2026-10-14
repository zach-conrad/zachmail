import { ProviderAuthError, ProviderError, type FetchLike, type TokenSource } from '../types'

export class GraphHttpError extends ProviderError {
  override name = 'GraphHttpError'
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    retriable = status === 429 || status >= 500,
  ) {
    super(message, retriable)
  }
}

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/**
 * Immutable ids keep a message's id stable when it moves between folders, which is how
 * archive, trash and spam work on Outlook. Every request must ask for them.
 */
const ID_PREFER = 'IdType="ImmutableId"'
const BATCH_LIMIT = 20
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export type Query = Record<string, string | number | undefined>

export interface BatchRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Path relative to /v1.0, query string included. */
  url: string
  body?: unknown
  /** Extra Prefer directives, e.g. odata.maxpagesize=100. */
  prefer?: string
}

export interface BatchResponse<T = unknown> {
  status: number
  body: T
}

/** Builds a relative Graph URL; `$` keys stay literal so batch sub-requests read naturally. */
export function graphPath(path: string, query: Query = {}) {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `${path}?${qs}` : path
}

/**
 * Thin Graph REST client: immutable ids, one forced token refresh on 401, backoff on
 * 429/503/504 (honouring Retry-After), and JSON batching of up to 20 requests per call.
 */
export class GraphApi {
  constructor(
    private tokens: TokenSource,
    private fetchImpl: FetchLike = fetch,
    private maxRetries = 4,
  ) {}

  /** `pathOrUrl` may be an absolute @odata.nextLink / deltaLink. */
  get<T>(pathOrUrl: string, query: Query = {}, opts: { pageSize?: number } = {}) {
    const prefer = opts.pageSize ? `odata.maxpagesize=${opts.pageSize}` : undefined
    return this.request<T>('GET', graphPath(pathOrUrl, query), { prefer })
  }

  /** `idempotent: false` (sends) never retries a 5xx: Graph may have acted before failing. */
  post<T>(path: string, body?: unknown, opts: { idempotent?: boolean } = {}) {
    return this.request<T>('POST', path, { body, idempotent: opts.idempotent ?? true })
  }

  patch<T>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body })
  }

  /** Creates a message from a whole RFC 822 message (Graph takes it base64 as text/plain). */
  postMime<T>(path: string, raw: Uint8Array) {
    return this.request<T>('POST', path, { mime: Buffer.from(raw).toString('base64') })
  }

  async getBytes(path: string): Promise<Uint8Array> {
    return this.request<Uint8Array>('GET', path, { bytes: true })
  }

  /**
   * Runs requests through /$batch, 20 at a time, returning responses in input order.
   * Throttled or unavailable sub-requests are retried; other failures come back as-is.
   */
  async batch<T = unknown>(requests: BatchRequest[]): Promise<BatchResponse<T>[]> {
    const out = new Array<BatchResponse<T>>(requests.length)
    const chunks: number[][] = []
    for (let i = 0; i < requests.length; i += BATCH_LIMIT)
      chunks.push(requests.slice(i, i + BATCH_LIMIT).map((_, j) => i + j))

    await Promise.all(
      chunks.map(async (chunk) => {
        let pending = chunk
        for (let attempt = 0; pending.length; attempt++) {
          const res = await this.request<{
            responses: { id: string; status: number; headers?: Record<string, string>; body: T }[]
          }>('POST', '/$batch', {
            body: {
              requests: pending.map((i) => ({
                id: String(i),
                method: requests[i]!.method,
                url: requests[i]!.url,
                headers: {
                  prefer: [ID_PREFER, requests[i]!.prefer].filter(Boolean).join(', '),
                  ...(requests[i]!.body !== undefined
                    ? { 'content-type': 'application/json' }
                    : {}),
                },
                body: requests[i]!.body,
              })),
            },
          })
          let wait = 0
          const retry: number[] = []
          for (const r of res.responses) {
            const i = Number(r.id)
            if (isThrottled(r.status) && attempt < this.maxRetries) {
              retry.push(i)
              wait = Math.max(
                wait,
                Number(r.headers?.['Retry-After'] ?? r.headers?.['retry-after']),
              )
            } else out[i] = { status: r.status, body: r.body }
          }
          pending = retry
          if (pending.length) await sleep(backoff(wait, attempt))
        }
      }),
    )
    return out
  }

  private async request<T>(
    method: string,
    pathOrUrl: string,
    opts: {
      body?: unknown
      mime?: string
      prefer?: string
      idempotent?: boolean
      bytes?: boolean
    } = {},
  ): Promise<T> {
    const url = /^https:\/\//.test(pathOrUrl) ? pathOrUrl : GRAPH_BASE + pathOrUrl
    if (!url.startsWith(GRAPH_BASE + '/')) throw new Error(`Refusing non-Graph URL ${url}`)
    const idempotent = opts.idempotent ?? true

    let forced = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken(forced)
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          prefer: [ID_PREFER, opts.prefer].filter(Boolean).join(', '),
          ...(opts.mime !== undefined
            ? { 'content-type': 'text/plain' }
            : opts.body !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
        },
        body: opts.mime ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      })
      if (res.ok) {
        if (opts.bytes) return new Uint8Array(await res.arrayBuffer()) as T
        const text = await res.text()
        return (text ? JSON.parse(text) : undefined) as T
      }

      if (res.status === 401 && !forced) {
        forced = true
        continue
      }
      if (res.status === 401) throw new ProviderAuthError('Microsoft rejected the access token')
      const retriable = res.status === 429 || (idempotent && res.status >= 500)
      if (retriable && attempt < this.maxRetries) {
        await sleep(backoff(Number(res.headers.get('retry-after')), attempt))
        continue
      }
      const text = await res.text()
      let code: string | undefined
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code
      } catch {
        // not JSON
      }
      const path = url.slice(GRAPH_BASE.length).split('?')[0]
      throw new GraphHttpError(
        res.status,
        `Graph ${method} ${path} → ${res.status}: ${text}`,
        code,
        retriable,
      )
    }
  }
}

const isThrottled = (status: number) => status === 429 || status === 503 || status === 504

const backoff = (retryAfterSeconds: number, attempt: number) =>
  retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 2 ** attempt * 500 + Math.random() * 250

/** Throws a failed batch sub-response as the error a direct request would have thrown. */
export function batchError(req: BatchRequest, res: BatchResponse): GraphHttpError {
  const err = (res.body as { error?: { code?: string; message?: string } } | undefined)?.error
  const path = req.url.split('?')[0]
  return new GraphHttpError(
    res.status,
    `Graph ${req.method} ${path} → ${res.status}: ${err?.message ?? ''}`.trim(),
    err?.code,
  )
}
