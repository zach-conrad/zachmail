/**
 * Wire format between the API and every client replica (web, macOS, iOS). Times are epoch
 * milliseconds so clients can sort and compare without parsing.
 */
import type { NudgeDismissalRow } from '../compose/nudges'
import type { SnippetRow } from '../compose/snippets'
import type { OpStatusRow } from './ops'

export interface Address {
  name?: string
  email: string
}

export type FolderKind =
  'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'archive' | 'starred' | 'important' | 'custom'

export interface AccountRow {
  id: string
  provider: 'gmail' | 'graph' | 'imap'
  email: string
  displayName: string | null
  shortName: string | null
  color: number
  status: string
  lastSyncedAt: number | null
  lastError: string | null
}

export interface FolderRow {
  id: string
  accountId: string
  providerId: string
  name: string
  kind: FolderKind
  unreadCount: number
  totalCount: number
}

export interface ThreadRow {
  id: string
  accountId: string
  subject: string
  snippet: string
  participants: Address[]
  lastMessageAt: number
  messageCount: number
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  folderIds: string[]
  /** New replies are archived automatically. Optional so older replicas stay valid. */
  muted?: boolean
}

export interface MessageRow {
  id: string
  threadId: string
  accountId: string
  from: Address | null
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  subject: string
  snippet: string
  date: number
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  listUnsubscribe: string | null
  rfc822MessageId: string | null
  bodyStatus: 'none' | 'cached'
}

export interface Rows {
  accounts: AccountRow[]
  folders: FolderRow[]
  threads: ThreadRow[]
  messages: MessageRow[]
  snippets: SnippetRow[]
  nudgeDismissals: NudgeDismissalRow[]
}

export interface Deletes {
  account: string[]
  folder: string[]
  thread: string[]
  message: string[]
  snippet: string[]
  nudgeDismissal: string[]
}

/** GET /api/sync?since=<seq>. Apply upserts then deletes; repeat while `more`. */
export interface SyncDelta {
  seq: number
  more: boolean
  upserts: Rows
  deletes: Deletes
  /** Status changes of ops this user POSTed to /api/ops (see ops.ts). */
  ops: OpStatusRow[]
}

/**
 * GET /api/bootstrap streams NDJSON: zero or more `{ rows }` chunks, then one `{ seq }` line.
 * Clients then continue with /api/sync?since=seq.
 */
export type BootstrapLine = { rows: Partial<Rows> } | { seq: number }

/** GET /api/messages/:id/body */
export interface MessageBody {
  messageId: string
  html: string
  hasRemoteImages: boolean
}

export const emptyRows = (): Rows => ({
  accounts: [],
  folders: [],
  threads: [],
  messages: [],
  snippets: [],
  nudgeDismissals: [],
})
export const emptyDeletes = (): Deletes => ({
  account: [],
  folder: [],
  thread: [],
  message: [],
  snippet: [],
  nudgeDismissal: [],
})
