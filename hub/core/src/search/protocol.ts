import type { MessageRow, ThreadRow } from '../sync/protocol'

/**
 * GET /api/search?q=&limit=&cursor=&olderThan=&tz=
 *
 * Clients search their replica first; this covers what the replica lacks. `olderThan` (epoch
 * ms) skips threads the replica already holds (it bootstraps only recent mail). `tz` is the
 * client's Date#getTimezoneOffset, so `before:2026/10/01` means the client's midnight.
 */
export interface SearchResponse {
  /** Newest first. */
  threads: ThreadRow[]
  /** Every message of those threads, so a result opens without another round trip. */
  messages: MessageRow[]
  /** Positive search tokens, for highlighting. */
  highlight: string[]
  /** Pass back as `cursor` for the next page; null when there are no more results. */
  nextCursor: string | null
  /** 'provider' once results come from the provider (mail older than the server mirror). */
  source: 'mirror' | 'provider'
}

export const SEARCH_PAGE = 50
export const MAX_SEARCH_PAGE = 100
