/**
 * Wire format between the API and every client replica (web, macOS, iOS). Times are epoch
 * milliseconds so clients can sort and compare without parsing.
 */
import type { ThreadAi } from './ai'
import type { NudgeDismissalRow } from '../compose/nudges'
import type { SnippetRow } from '../compose/snippets'
import type { OpStatusRow } from './ops'
import type { SplitRuleRow } from './split'

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
  /** Epoch ms the thread comes back to the inbox; null/absent when not snoozed. */
  snoozedUntil?: number | null
  /** Pending reminder (see ops.ts `remind`); null/absent when none. */
  reminder?: Reminder | null
  /** Triage result (see ai.ts); null/absent until triaged or while AI is off. */
  ai?: ThreadAi | null
}

/** `if_no_reply` fires only if nobody else has written in the thread since it was set. */
export type ReminderCondition = 'always' | 'if_no_reply'

export interface Reminder {
  at: number
  condition: ReminderCondition
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
  splitRules: SplitRuleRow[]
  snippets: SnippetRow[]
  nudgeDismissals: NudgeDismissalRow[]
}

export interface Deletes {
  account: string[]
  folder: string[]
  thread: string[]
  message: string[]
  splitRule: string[]
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
  splitRules: [],
  snippets: [],
  nudgeDismissals: [],
})
export const emptyDeletes = (): Deletes => ({
  account: [],
  folder: [],
  thread: [],
  message: [],
  splitRule: [],
  snippet: [],
  nudgeDismissal: [],
})
