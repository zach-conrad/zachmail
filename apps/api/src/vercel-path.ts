/**
 * Every /api/* and /webhooks/* request is routed to this one function with its original path
 * in `__zm_path` (see infra/vercel-build.mjs); put it back before Hono routes the request.
 */
export function restorePath(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://local')
  const original = url.searchParams.get('__zm_path')
  if (!original) return rawUrl
  url.searchParams.delete('__zm_path')
  return original + (url.search === '?' ? '' : url.search)
}
