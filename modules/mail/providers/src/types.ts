import type { Address } from '@zachhub/mime'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TokenSource {
  /** Returns a valid access token; `force` bypasses any cache after a 401. */
  getAccessToken(force?: boolean): Promise<string>
}

export type FolderKind =
  'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'important' | 'custom'

export interface ProviderFolder {
  providerId: string
  name: string
  kind: FolderKind
  unreadCount: number
  totalCount: number
}

export interface ProviderAttachment {
  filename: string
  mime: string
  size: number
  providerAttachmentId: string | null
  contentId: string | null
  inline: boolean
}

/** Message metadata (no body). Folder membership is expressed as provider folder ids. */
export interface ProviderMessage {
  providerMessageId: string
  providerThreadId: string
  rfc822MessageId: string | null
  inReplyTo: string | null
  references: string[]
  from: Address | null
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo: Address[]
  subject: string
  snippet: string
  date: Date
  folderIds: string[]
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  listUnsubscribe: string | null
  size: number
  attachments: ProviderAttachment[]
}

export interface SyncBatch {
  /** Full folder list when present (replaces the stored set's metadata). */
  folders?: ProviderFolder[]
  messages: ProviderMessage[]
  deletedMessageIds: string[]
}

/** Opaque per-provider sync cursor, stored in accounts.sync_state. */
export type SyncState = Record<string, unknown>

export interface RawBody {
  html: string | null
  text: string | null
  attachments: ProviderAttachment[]
}

export interface BackfillPage {
  batch: SyncBatch
  /** Pass back to continue; null when the backfill window is done. */
  cursor: string | null
}

export interface IncrementalResult {
  batch: SyncBatch
  next: SyncState
  /** The provider can no longer serve deltas from this state; run a full resync. */
  resyncRequired?: boolean
  /** More changes are waiting (a capped first pass); run another incremental soon. */
  more?: boolean
}

export interface WatchResult {
  state: SyncState
  expiresAt: Date
}

/** A triage change for whole threads, in provider folder ids. */
export interface ProviderChange {
  add: string[]
  remove: string[]
  unread?: boolean
  starred?: boolean
}

export interface SentRef {
  providerMessageId: string
  providerThreadId: string
}

export interface MailProvider {
  /**
   * Initial state to record before a backfill starts (e.g. the current Gmail historyId). Must
   * be non-empty: an empty state means the account has not started syncing.
   */
  initialState(): Promise<SyncState>
  /** One page of history, newest first. */
  backfillPage(
    cursor: string | null,
    opts?: { sinceDays?: number; beforeDays?: number },
  ): Promise<BackfillPage>
  incremental(state: SyncState): Promise<IncrementalResult>
  watch(state: SyncState): Promise<WatchResult>
  fetchBody(providerMessageId: string): Promise<RawBody>
  fetchAttachment(providerMessageId: string, providerAttachmentId: string): Promise<Uint8Array>
  /** Applies a change to every message of each thread. Threads that no longer exist are skipped. */
  apply(providerThreadIds: string[], change: ProviderChange): Promise<void>
  /** Sends a complete RFC 5322 message (Bcc header included), threaded when given a thread. */
  send(raw: Uint8Array, opts?: { providerThreadId?: string }): Promise<SentRef>
  /**
   * Creates or replaces a provider draft and returns its id. A `providerDraftId` that no
   * longer exists makes a new draft.
   */
  saveDraft(
    raw: Uint8Array,
    opts: { providerDraftId?: string | null; providerThreadId?: string },
  ): Promise<string>
  /** Deletes a provider draft; one that is already gone is fine. */
  deleteDraft(providerDraftId: string): Promise<void>
  /** Current metadata of whole threads, used to restore the mirror after a failed write. */
  fetchThreads(providerThreadIds: string[]): Promise<SyncBatch>
  /** Threads matching a query in the provider's own syntax, newest first. */
  searchThreads(
    query: string,
    opts: { limit: number; pageToken?: string | null },
  ): Promise<SearchPage>
}

export interface SearchPage {
  providerThreadIds: string[]
  /** Pass back to continue; null when there are no more results. */
  pageToken: string | null
}

export class ProviderAuthError extends Error {
  override name = 'ProviderAuthError'
}

/** A provider request that failed; `retriable` when trying again later may succeed. */
export class ProviderError extends Error {
  override name = 'ProviderError'
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message)
  }
}
