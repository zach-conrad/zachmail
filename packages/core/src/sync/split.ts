import type { FolderKind } from './protocol'

/** Built-in inbox splits (design spec §2). Custom splits are saved searches and come later. */
export const SPLIT_IDS = ['important', 'other', 'newsletters', 'notifications'] as const
export type SplitId = (typeof SPLIT_IDS)[number]

// Local parts that only machines send from. Kept narrow on purpose: a false "notification"
// hides a human, which is worse than an automated mail landing in Other.
const AUTOMATED_LOCAL =
  /^(?:no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|automated|robot|receipts?|billing)(?:[+.\-_]|$)/i

export interface SplitInput {
  /** Kinds of every folder/label the thread is in. */
  folderKinds: readonly FolderKind[]
  /** True when the account has an "important" label at all (Gmail does, IMAP does not). */
  accountHasImportant: boolean
  /** Any message in the thread carries List-Unsubscribe. */
  hasListUnsubscribe: boolean
  /** Sender of the latest inbound message. */
  fromEmail: string | null
}

/**
 * Which inbox split a thread belongs to, or null when it is not in the inbox. Pure so web,
 * macOS and iOS classify identically: newsletters (List-Unsubscribe), then notifications
 * (automated senders), then important (humans the provider flags important, or every human
 * when the provider has no such flag), else other.
 */
export function classifySplit(t: SplitInput): SplitId | null {
  if (!t.folderKinds.includes('inbox')) return null
  if (t.hasListUnsubscribe) return 'newsletters'
  const local = t.fromEmail?.split('@')[0] ?? ''
  if (AUTOMATED_LOCAL.test(local)) return 'notifications'
  if (!t.accountHasImportant || t.folderKinds.includes('important')) return 'important'
  return 'other'
}
