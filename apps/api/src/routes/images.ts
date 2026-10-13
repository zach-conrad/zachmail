import { verifyImageSignature } from '@zachmail/engine'
import { Hono } from 'hono'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Deps } from '../deps'

const MAX_BYTES = 10 * 1024 * 1024

/**
 * Remote images in mail load through here: it hides Zach's IP and headers from senders, strips
 * cookies, and only serves images. URLs are HMAC-signed by the server when sanitizing, so it
 * can't be used as an open proxy.
 */
export function imageRoutes(deps: Deps) {
  const app = new Hono()
  app.get('/img', async (c) => {
    const url = c.req.query('u') ?? ''
    const sig = c.req.query('s') ?? ''
    if (!verifyImageSignature(url, sig, deps.engineConfig().imageProxySecret))
      return c.body(null, 403)

    let target: URL
    try {
      target = new URL(url)
    } catch {
      return c.body(null, 400)
    }
    if (!/^https?:$/.test(target.protocol) || !(await isPublicHost(target.hostname)))
      return c.body(null, 403)

    const res = await deps
      .fetch(target.toString(), {
        headers: { 'user-agent': 'Mozilla/5.0 (ZachMail image proxy)', accept: 'image/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10_000),
      })
      .catch(() => null)
    const type = res?.headers.get('content-type') ?? ''
    if (!res?.ok || !type.startsWith('image/') || type.includes('svg')) return c.body(null, 404)
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) return c.body(null, 413)

    const bytes = await res.arrayBuffer()
    if (bytes.byteLength > MAX_BYTES) return c.body(null, 413)
    return c.body(bytes, 200, {
      'content-type': type,
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    })
  })
  return app
}

/** Rejects loopback, private, link-local and metadata addresses (SSRF guard). */
export async function isPublicHost(host: string): Promise<boolean> {
  const addrs = isIP(host)
    ? [host]
    : await lookup(host, { all: true }).then(
        (r) => r.map((a) => a.address),
        () => [],
      )
  return addrs.length > 0 && addrs.every((a) => !isPrivate(a))
}

function isPrivate(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase()
    if (v.startsWith('::ffff:')) return isPrivate(v.slice(7))
    return (
      v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
    )
  }
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  )
}
