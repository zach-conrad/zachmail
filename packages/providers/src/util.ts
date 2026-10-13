/** Runs fn over items with at most `limit` in flight, preserving input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

export function decodeBase64Url(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

export function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}
