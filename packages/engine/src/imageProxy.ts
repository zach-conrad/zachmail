import { createHmac, timingSafeEqual } from 'node:crypto'

const sign = (url: string, secret: string) =>
  createHmac('sha256', secret).update(url).digest('base64url').slice(0, 32)

/** Relative proxy URL for a remote image; the signature stops the proxy being an open relay. */
export function proxiedImageUrl(url: string, secret: string): string {
  return `/api/img?u=${encodeURIComponent(url)}&s=${sign(url, secret)}`
}

export function verifyImageSignature(url: string, sig: string, secret: string): boolean {
  const expected = Buffer.from(sign(url, secret))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
