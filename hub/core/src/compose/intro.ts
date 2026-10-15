/**
 * Instant intro (⌘⇧I in a reply): answering an introduction, the person who made it moves to
 * Bcc and the reply opens with a thank-you, so they see the hand-off and drop off the thread.
 */
import type { Address, MessageRow } from '../sync/protocol'
import { mergeAddresses, splitName } from './snippets'

export interface IntroDraft {
  to: Address[]
  cc: Address[]
  bcc: Address[]
  html: string
}

/** Marks the inserted line so applying twice never stacks two thank-yous. */
const MARK = 'data-zm-intro'

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The thank-you line, e.g. "Thanks Ana (moved to Bcc)!" */
export function introLine(introducer: Address): string {
  const first = splitName(introducer).first
  return `<p ${MARK}="">Thanks${first ? ` ${escapeHtml(first)}` : ''} (moved to Bcc)!</p>`
}

/**
 * Rewrites a reply draft to the intro message `introMessage`: its sender goes to Bcc, everyone
 * else it was addressed to (minus Zach's own addresses) ends up on To, and the body starts with
 * `introLine`. Returns null when there is nobody to hand off to or the sender is Zach.
 */
export function instantIntro(
  draft: IntroDraft,
  introMessage: Pick<MessageRow, 'from' | 'to' | 'cc' | 'replyTo'>,
  ownEmails: ReadonlySet<string>,
): IntroDraft | null {
  const introducer = introMessage.replyTo[0] ?? introMessage.from
  if (!introducer) return null
  const key = (a: Address) => a.email.toLowerCase()
  const introKey = key(introducer)
  if (ownEmails.has(introKey)) return null
  const isIntroducer = (a: Address) =>
    key(a) === introKey || key(a) === introMessage.from?.email.toLowerCase()
  const notMine = (a: Address) => !ownEmails.has(key(a))

  // People introduced: whoever the intro went to besides Zach, plus anyone already on the draft.
  const introduced = [...introMessage.to, ...introMessage.cc].filter(
    (a) => notMine(a) && !isIntroducer(a),
  )
  const keptCc = draft.cc.filter((a) => !isIntroducer(a))
  const to = mergeAddresses(
    draft.to.filter((a) => !isIntroducer(a)),
    introduced,
    keptCc,
  )
  if (!to.length && !keptCc.length) return null

  const bcc = mergeAddresses(
    draft.bcc.filter((a) => !isIntroducer(a)),
    [introducer],
  )
  const html = draft.html.includes(MARK) ? draft.html : introLine(introducer) + draft.html
  return { to: to.length ? to : keptCc, cc: to.length ? keptCc : [], bcc, html }
}
