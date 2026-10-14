import { ProviderAuthError, ProviderError } from '../types'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TokenSource {
  /** Returns a valid access token; `force` bypasses any cache after a 401. */
  getAccessToken(force?: boolean): Promise<string>
}

export class GmailHttpError extends ProviderError {
  override name = 'GmailHttpError'
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message, status === 429 || status >= 500)
  }
}

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Thin Gmail REST client: auth, one forced token refresh on 401, backoff on 429/5xx. */
export class GmailApi {
  constructor(
    private tokens: TokenSource,
    private fetchImpl: FetchLike = fetch,
    private maxRetries = 4,
  ) {}

  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | string[] | undefined> = {},
  ) {
    return this.request<T>('GET', path, query)
  }

  async post<T>(path: string, body: unknown) {
    return this.request<T>('POST', path, {}, body)
  }

  private async request<T>(
    method: string,
    path: string,
    query: Record<string, string | number | boolean | string[] | undefined>,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(BASE + path)
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x))
      else url.searchParams.set(k, String(v))
    }

    let forced = false
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getAccessToken(forced)
      const res = await this.fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (res.ok) return (await res.json()) as T

      if (res.status === 401 && !forced) {
        forced = true
        continue
      }
      if (res.status === 401) throw new ProviderAuthError('Gmail rejected the access token')
      const retriable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && (await isRateLimit(res.clone())))
      if (retriable && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500 + Math.random() * 250)
        continue
      }
      throw new GmailHttpError(
        res.status,
        `Gmail ${method} ${path} → ${res.status}: ${await res.text()}`,
      )
    }
  }
}

async function isRateLimit(res: Response): Promise<boolean> {
  try {
    const j = (await res.json()) as { error?: { errors?: { reason?: string }[] } }
    return !!j.error?.errors?.some(
      (e) => e.reason === 'rateLimitExceeded' || e.reason === 'userRateLimitExceeded',
    )
  } catch {
    return false
  }
}
