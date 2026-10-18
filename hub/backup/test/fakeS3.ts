/** An in-memory S3 bucket behind a fetch function, for the client, job and prune tests. */
export function fakeS3(opts: { pageSize?: number; failPut?: boolean } = {}) {
  const objects = new Map<string, { body: Uint8Array; lastModified: Date }>()
  const requests: string[] = []
  const pageSize = opts.pageSize ?? 1000
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    requests.push(`${method} ${input}`)
    const headers = init.headers as Record<string, string>
    if (!headers.authorization?.startsWith('AWS4-HMAC-SHA256 '))
      return new Response('', { status: 403 })
    const url = new URL(input)
    const [, , ...rest] = url.pathname.split('/')
    const key = decodeURIComponent(rest.join('/'))
    if (!key && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? ''
      const start = Number(url.searchParams.get('continuation-token') ?? 0)
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const page = all.slice(start, start + pageSize)
      const more = start + pageSize < all.length
      const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      return new Response(
        `<ListBucketResult>${page
          .map(
            (k) =>
              `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size>` +
              `<LastModified>${objects.get(k)!.lastModified.toISOString()}</LastModified></Contents>`,
          )
          .join('')}<IsTruncated>${more}</IsTruncated>${
          more ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''
        }</ListBucketResult>`,
      )
    }
    if (method === 'PUT') {
      if (opts.failPut)
        return new Response('<Error><Code>InternalError</Code></Error>', { status: 500 })
      objects.set(key, { body: new Uint8Array(init.body as Uint8Array), lastModified: new Date() })
      return new Response('')
    }
    if (method === 'GET') {
      const o = objects.get(key)
      return o
        ? new Response(o.body)
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    }
    if (method === 'DELETE') {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    return new Response('', { status: 405 })
  }
  return { fetch: fetchImpl, objects, requests }
}
