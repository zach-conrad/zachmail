import type { DataClient } from '../data/client'
import type { PaletteSource } from '../hub/palette'
import { senderLabel } from '../lib/format'

const LIMIT = 5

/**
 * Mail's part of the universal ⌘K: threads matching the query in the local search index,
 * and "Search mail for …" to open full search. Small and eager, so ⌘K finds mail from any
 * module without loading the Mail chunk.
 */
export function mailPaletteSource(
  client: DataClient,
  ownEmails: ReadonlySet<string>,
  go: { thread: (id: string) => void; search: (query: string) => void },
): PaletteSource {
  const tzOffset = new Date().getTimezoneOffset()
  return {
    module: 'mail',
    async search(query) {
      const rows = await client.api.listThreads({ search: query, tzOffset }, 0, LIMIT)
      return rows.map((t) => ({
        id: `mail.thread.${t.id}`,
        label: t.subject || '(no subject)',
        detail: senderLabel(t.participants, ownEmails),
        run: () => go.thread(t.id),
      }))
    },
    fallback: (query) => ({
      id: 'mail.search',
      label: `Search mail for “${query}”`,
      keys: '/',
      run: () => go.search(query),
    }),
  }
}
