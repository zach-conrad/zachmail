import type { FetchLike } from '@zachhub/providers/gmail'

export interface StorageConfig {
  /** Supabase project URL. */
  url: string
  serviceKey: string
  bucket: string
}

/** Minimal Supabase Storage client (service role) for outgoing attachments. */
export class Storage {
  constructor(
    private config: StorageConfig,
    private fetchImpl: FetchLike = fetch,
  ) {}

  private headers() {
    return { authorization: `Bearer ${this.config.serviceKey}`, apikey: this.config.serviceKey }
  }

  private objectUrl(kind: string, path: string) {
    const key = path.split('/').map(encodeURIComponent).join('/')
    return `${this.config.url}/storage/v1/object/${kind}${this.config.bucket}/${key}`
  }

  /** A URL the browser can PUT the file to directly (no API body-size limits). */
  async signUpload(path: string): Promise<string> {
    const res = await this.fetchImpl(this.objectUrl('upload/sign/', path), {
      method: 'POST',
      headers: this.headers(),
    })
    if (!res.ok) throw new Error(`Storage sign failed: ${res.status} ${await res.text()}`)
    const { url } = (await res.json()) as { url: string }
    return `${this.config.url}/storage/v1${url}`
  }

  async download(path: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(this.objectUrl('', path), { headers: this.headers() })
    if (!res.ok) throw new Error(`Storage download failed: ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  /** Deletes objects; missing ones are ignored. */
  async remove(paths: string[]): Promise<void> {
    if (!paths.length) return
    const res = await this.fetchImpl(`${this.config.url}/storage/v1/object/${this.config.bucket}`, {
      method: 'DELETE',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: paths }),
    })
    if (!res.ok) throw new Error(`Storage delete failed: ${res.status}`)
  }
}
