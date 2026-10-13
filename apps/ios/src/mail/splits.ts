/** Built-in splits (design §2). Custom splits (saved searches) come later. */
import type { Address, MessageRow, ThreadRow } from '@zachmail/core'

export const splits = [
  { id: 'important', label: 'Important' },
  { id: 'other', label: 'Other' },
  { id: 'newsletters', label: 'Newsletters' },
  { id: 'notifications', label: 'Notifications' },
] as const

export type SplitId = (typeof splits)[number]['id']

const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|receipts?|billing|mailer-daemon|bounces?)([+.-]|$)/i
const AUTOMATED_DOMAINS = new Set([
  'github.com',
  'stripe.com',
  'vercel.com',
  'linear.app',
  'google.com',
  'apple.com',
])

export function isAutomated(addr: Address): boolean {
  const [local = '', domain = ''] = addr.email.toLowerCase().split('@')
  return AUTOMATED_LOCAL.test(local) || AUTOMATED_DOMAINS.has(domain)
}

export interface SplitContext {
  /** Zach's own addresses across all accounts. */
  me: Set<string>
  /** Everyone Zach has ever written to; a human counts as Important once he has. */
  correspondents: Set<string>
}

export function splitContext(
  accountEmails: string[],
  messages: Iterable<MessageRow>,
): SplitContext {
  const me = new Set(accountEmails.map((e) => e.toLowerCase()))
  const correspondents = new Set<string>()
  for (const m of messages) {
    if (!m.from || !me.has(m.from.email.toLowerCase())) continue
    for (const a of [...m.to, ...m.cc]) correspondents.add(a.email.toLowerCase())
  }
  return { me, correspondents }
}

/**
 * Which split a thread belongs to, from its newest message not sent by Zach:
 * automated senders → Notifications, List-Unsubscribe → Newsletters, people Zach writes to or
 * starred threads → Important, anyone else → Other.
 */
export function classify(
  thread: ThreadRow,
  messages: readonly MessageRow[],
  ctx: SplitContext,
): SplitId {
  const latest = [...messages]
    .reverse()
    .find((m) => m.from && !ctx.me.has(m.from.email.toLowerCase()))
  if (!latest?.from) return 'important'
  if (isAutomated(latest.from)) return 'notifications'
  if (latest.listUnsubscribe) return 'newsletters'
  if (thread.starred || ctx.correspondents.has(latest.from.email.toLowerCase())) return 'important'
  return 'other'
}
