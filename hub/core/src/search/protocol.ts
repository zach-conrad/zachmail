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

/** One result of a hub search: a module's row or a mail thread. */
export interface HubSearchHit {
  /** Entity kind ('tasks.task'), or 'mail.thread' for mail. */
  kind: string
  id: string
  title: string
  /** The start of the body (a mail thread's snippet); highlight with highlightRanges. */
  snippet: string
  /** Epoch ms: the row's last change, or a thread's last message. */
  updatedAt: number
  /** Postgres ts_rank, plus a little for title similarity; higher is better. */
  rank: number
}

/**
 * GET /api/search/hub?q=&limit=&tz=
 *
 * One search over every module's index (hub.search_index) and the mail mirror, best first.
 * `in:<module>` limits it (`in:tasks`, `-in:mail`). No provider fallback: mail older than the
 * mirror stays with /api/search.
 */
export interface HubSearchResponse {
  hits: HubSearchHit[]
  /** Positive search tokens, for highlighting. */
  highlight: string[]
}

export const HUB_SEARCH_PAGE = 30
/** The `kind` of mail hits; `in:mail` scopes to them. */
export const MAIL_THREAD_KIND = 'mail.thread'
