/**
 * Sending local snippet and nudge-dismissal edits. Like split rules, they are applied to the
 * replica first and sent in order; the server echo arrives later in a delta.
 */
import { HttpError, type HttpTransportOptions } from '../sync/http'
import type { NudgeDismissalRow } from './nudges'
import type { SnippetRow } from './snippets'

/** A local edit waiting for the server; `value` null is a delete (or a restored nudge). */
export type ComposerEdit =
  | { kind: 'snippet'; id: string; value: SnippetRow | null }
  | { kind: 'nudge'; id: string; value: NudgeDismissalRow | null }

export interface ComposerRemote {
  putSnippet(s: SnippetRow): Promise<void>
  deleteSnippet(id: string): Promise<void>
  dismissNudges(threadIds: string[]): Promise<void>
  restoreNudges(threadIds: string[]): Promise<void>
}

export interface ComposerOutbox {
  pending(): ComposerEdit[]
  ack(sent: ComposerEdit): void
  reject(sent: ComposerEdit): void
}

/**
 * Sends pending edits in order. 4xx answers are final (the edit is dropped and the synced row
 * shows again); anything else stops the flush so it retries next time. Returns how many settled.
 */
export async function flushComposerEdits(
  outbox: ComposerOutbox,
  remote: ComposerRemote,
): Promise<number> {
  let settled = 0
  for (const e of outbox.pending()) {
    try {
      if (e.kind === 'snippet')
        await (e.value ? remote.putSnippet(e.value) : remote.deleteSnippet(e.id))
      else await (e.value ? remote.dismissNudges([e.id]) : remote.restoreNudges([e.id]))
      outbox.ack(e)
    } catch (err) {
      const status = (err as { status?: number }).status
      const retry = status === undefined || status < 400 || status >= 500
      if (retry || status === 401 || status === 408 || status === 429) throw err
      outbox.reject(e)
    }
    settled++
  }
  return settled
}

/** /api/snippets and /api/nudges, with the same auth as the sync transport. */
export function composerHttp(opts: HttpTransportOptions): ComposerRemote {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const base = opts.baseUrl ?? ''
  const send = async (method: 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) => {
    const token = await opts.token()
    const res = await f(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) throw new HttpError(res.status, path)
  }
  const snippet = (id: string) => `/api/snippets/${encodeURIComponent(id)}`
  return {
    putSnippet: ({ id, name, shortcut, subject, html, cc, bcc }) =>
      send('PUT', snippet(id), { name, shortcut, subject, html, cc, bcc }),
    deleteSnippet: (id) => send('DELETE', snippet(id)),
    dismissNudges: (threadIds) => send('POST', '/api/nudges/dismiss', { threadIds }),
    restoreNudges: (threadIds) => send('POST', '/api/nudges/restore', { threadIds }),
  }
}
