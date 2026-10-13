import type { Address } from '@zachmail/mime'

export type FolderKind =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'starred'
  | 'important'
  | 'custom'

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
}

export interface WatchResult {
  state: SyncState
  expiresAt: Date
}

export interface MailProvider {
  /** Initial state to record before a backfill starts (e.g. the current Gmail historyId). */
  initialState(): Promise<SyncState>
  /** One page of history, newest first. */
  backfillPage(cursor: string | null, opts?: { sinceDays?: number }): Promise<BackfillPage>
  incremental(state: SyncState): Promise<IncrementalResult>
  watch(state: SyncState): Promise<WatchResult>
  fetchBody(providerMessageId: string): Promise<RawBody>
  fetchAttachment(providerMessageId: string, providerAttachmentId: string): Promise<Uint8Array>
}

export class ProviderAuthError extends Error {
  override name = 'ProviderAuthError'
}
