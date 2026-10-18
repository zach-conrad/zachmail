/**
 * Runs fn over items with at most `limit` in flight, preserving input order in the result. On
 * the first failure no new items start, and it rejects with that error only once the calls
 * already in flight have settled, so nothing keeps running behind a failed job's retry.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed: { error: unknown } | undefined
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!)
      } catch (error) {
        failed ??= { error }
      }
    }
  })
  await Promise.all(workers)
  if (failed) throw failed.error
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
