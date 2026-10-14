/**
 * Follow-up nudges: threads where Zach wrote last and nobody has answered for a few days.
 * Computed on the replica from threads and messages it already has (no server round trip), so
 * the list is ready the moment it is opened. Dismissing one hides it until the thread moves
 * (a dismissal stores the thread's `lastMessageAt`).
 *
 * Explicit "remind me if no reply" lives with snooze; nudges cover the sends nobody set one on.
 */
import type { Address, MessageRow, ThreadRow } from '../sync/protocol'

/** Synced as the `nudgeDismissal` entity; `id` is the thread id. */
export interface NudgeDismissalRow {
  id: string
  /** The thread's lastMessageAt when dismissed. A newer message brings the nudge back. */
  lastMessageAt: number
}

export interface FollowUpNudge {
  threadId: string
  /** Zach's unanswered message. */
  messageId: string
  sentAt: number
  /** Who hasn't answered. */
  waitingOn: Address[]
  /** When the nudge became due (sentAt + after). */
  dueAt: number
}

export interface NudgeOptions {
  /** Nudge after this long without a reply. Default 3 days. */
  afterMs?: number
  /** Stop nudging sends older than this. Default 30 days. */
  windowMs?: number
}

export const DEFAULT_NUDGE_AFTER_MS = 3 * 24 * 60 * 60 * 1000
export const DEFAULT_NUDGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** Addresses that never answer. */
const AUTOMATED =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounces?|alerts?|updates|news(letter)?|support|billing|receipts?|calendar-notification)([+._-]|@)/i

/** Sends that close a conversation rather than ask for something. */
const CLOSER =
  /^\s*(thanks|thank you|thx|ty|cheers|sounds good|great|perfect|awesome|got it|will do|ok(ay)?|cool|nice|noted|done|👍|🙏)\b[\s!.,:)]*([-—–]\s*\w+[\s!.]*)?$/i

export interface NudgeContext {
  /** Zach's addresses, lowercase (accounts and send-as aliases). */
  ownEmails: ReadonlySet<string>
  /** Folder ids where nothing should nudge (trash, spam). */
  skipFolderIds?: ReadonlySet<string>
  dismissals?: ReadonlyMap<string, number>
  /** E.g. threads with an explicit reminder or a snooze already. */
  skip?: (threadId: string) => boolean
  now: number
}

/**
 * The nudge for one thread, or null. `messages` are the thread's messages in any order.
 */
export function followUpNudge(
  thread: ThreadRow,
  messages: readonly MessageRow[],
  ctx: NudgeContext,
  opts: NudgeOptions = {},
): FollowUpNudge | null {
  const after = opts.afterMs ?? DEFAULT_NUDGE_AFTER_MS
  const window = opts.windowMs ?? DEFAULT_NUDGE_WINDOW_MS
  const age = ctx.now - thread.lastMessageAt
  if (age < after || age > window) return null
  if (thread.muted) return null
  if (ctx.skipFolderIds && thread.folderIds.some((f) => ctx.skipFolderIds!.has(f))) return null
  const dismissedAt = ctx.dismissals?.get(thread.id)
  if (dismissedAt !== undefined && dismissedAt >= thread.lastMessageAt) return null
  if (ctx.skip?.(thread.id)) return null

  let last: MessageRow | undefined
  for (const m of messages) if (!last || m.date > last.date) last = m
  if (!last || !last.from || !ctx.ownEmails.has(last.from.email.toLowerCase())) return null
  if (CLOSER.test(last.snippet)) return null

  const waitingOn = [...last.to, ...last.cc].filter((a) => {
    const e = a.email.toLowerCase()
    return !ctx.ownEmails.has(e) && !AUTOMATED.test(e)
  })
  if (!waitingOn.length) return null
  return {
    threadId: thread.id,
    messageId: last.id,
    sentAt: last.date,
    waitingOn,
    dueAt: last.date + after,
  }
}

/** Every due nudge, most recently due first. */
export function followUpNudges(
  threads: Iterable<ThreadRow>,
  messagesOf: (threadId: string) => readonly MessageRow[],
  ctx: NudgeContext,
  opts: NudgeOptions = {},
): FollowUpNudge[] {
  const after = opts.afterMs ?? DEFAULT_NUDGE_AFTER_MS
  const window = opts.windowMs ?? DEFAULT_NUDGE_WINDOW_MS
  const out: FollowUpNudge[] = []
  for (const t of threads) {
    // Cheap age check first so messages are only read for candidates.
    const age = ctx.now - t.lastMessageAt
    if (age < after || age > window) continue
    const n = followUpNudge(t, messagesOf(t.id), ctx, opts)
    if (n) out.push(n)
  }
  return out.sort((a, b) => b.dueAt - a.dueAt)
}
