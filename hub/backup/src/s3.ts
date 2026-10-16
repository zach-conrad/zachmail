import { createHash, createHmac } from 'node:crypto'

/**
 * Just enough S3 for backups (put, get, list, delete), signed with SigV4 and path-style URLs,
 * which Cloudflare R2, Backblaze B2 and AWS all accept. No SDK: four calls don't need one.
 */
export interface S3Config {
  /** https://<account>.r2.cloudflarestorage.com, https://s3.<region>.backblazeb2.com, … */
  endpoint: string
  bucket: string
  /** 'auto' for R2; B2 and AWS want the bucket's region, e.g. 'us-west-004'. */
  region: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3Object {
  key: string
  size: number
  lastModified: Date
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding as SigV4 wants it; `/` kept in object keys. */
const enc = (s: string, keepSlash = false) => {
  const e = encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return keepSlash ? e.replaceAll('%2F', '/') : e
}

export class S3Error extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class S3Client {
  constructor(
    private config: S3Config,
    private fetchImpl: Fetch = fetch,
    private now: () => Date = () => new Date(),
  ) {}

  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream') {
    await this.send('PUT', key, {}, body, { 'content-type': contentType })
  }

  /** The object's bytes, or null when it doesn't exist. */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await (await this.send('GET', key)).arrayBuffer())
    } catch (err) {
      if (err instanceof S3Error && err.status === 404) return null
      throw err
    }
  }

  async delete(key: string) {
    await this.send('DELETE', key)
  }

  /** Every object under `prefix`, following continuation tokens. */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = []
    let token: string | undefined
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix }
      if (token) query['continuation-token'] = token
      const xml = await (await this.send('GET', '', query)).text()
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const tag = (name: string) => m[1]!.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1]
        out.push({
          key: unxml(tag('Key') ?? ''),
          size: Number(tag('Size') ?? 0),
          lastModified: new Date(tag('LastModified') ?? 0),
        })
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? unxml(xml.match(/<NextContinuationToken>([^<]*)</)?.[1] ?? '')
        : undefined
    } while (token)
    return out
  }

  private async send(
    method: string,
    key: string,
    query: Record<string, string> = {},
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const { url, headers } = this.sign(method, key, query, body, extraHeaders)
    const res = await this.fetchImpl(url, { method, headers, body: body as BodyInit | undefined })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const code = text.match(/<Code>([^<]*)</)?.[1]
      throw new S3Error(
        res.status,
        `S3 ${method} ${key || '/'} failed: ${res.status} ${code ?? ''}`.trim(),
      )
    }
    return res
  }

  private sign(
    method: string,
    key: string,
    query: Record<string, string>,
    body: Uint8Array | undefined,
    extraHeaders: Record<string, string>,
  ) {
    const { endpoint, bucket } = this.config
    const base = new URL(endpoint)
    const path = `${base.pathname.replace(/\/$/, '')}/${enc(bucket)}${key ? `/${enc(key, true)}` : ''}`
    const headers = signRequest(this.config, {
      method,
      host: base.host,
      path,
      query,
      headers: extraHeaders,
      payloadHash: sha256(body ?? ''),
      now: this.now(),
    })
    const qs = canonicalQuery(query)
    return { url: `${base.origin}${path}${qs ? `?${qs}` : ''}`, headers }
  }
}

const canonicalQuery = (query: Record<string, string>) =>
  Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k]!)}`)
    .join('&')

export interface SignInput {
  method: string
  host: string
  /** Already URI-encoded. */
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  payloadHash: string
  now: Date
}

/** AWS Signature Version 4. Returns the headers to send (host excluded; fetch sets it). */
export function signRequest(
  creds: Pick<S3Config, 'region' | 'accessKeyId' | 'secretAccessKey'>,
  req: SignInput,
): Record<string, string> {
  const amzDate = req.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: req.host,
    'x-amz-content-sha256': req.payloadHash,
    'x-amz-date': amzDate,
  }
  const signed = Object.keys(headers).sort()
  const canonical = [
    req.method,
    req.path,
    canonicalQuery(req.query),
    signed.map((h) => `${h}:${headers[h]!.trim()}\n`).join(''),
    signed.join(';'),
    req.payloadHash,
  ].join('\n')
  const scope = `${day}/${creds.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), creds.region), 's3'),
    'aws4_request',
  )
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`
  delete headers.host
  return headers
}

const unxml = (s: string) =>
  s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
