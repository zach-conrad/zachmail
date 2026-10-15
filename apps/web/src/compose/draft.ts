import type { Address, DraftRequest, MessageRow, SendRequest } from '@zachhub/core'
import type { ThreadDetail } from '@zachhub/local-store'
import { longTime } from '../lib/format'

export type ComposeKind = 'new' | 'reply' | 'replyAll' | 'forward'

/** Everything a composer holds; plain text body, rendered to HTML on save and send. */
export interface Draft {
  /** Client UUID of the provider draft (PUT /api/drafts/:id). */
  id: string
  kind: ComposeKind
  accountId: string
  to: Address[]
  cc: Address[]
  bcc: Address[]
  subject: string
  text: string
  threadId?: string
  replyToMessageId?: string
  /** Forwarded message, already sanitized HTML, appended below the text. */
  quoted?: string
  /** A reply shown as the centered sheet (e.g. a follow-up started outside its thread). */
  sheet?: boolean
}

const uuid = () => crypto.randomUUID()

export function newDraft(accountId: string): Draft {
  return { id: uuid(), kind: 'new', accountId, to: [], cc: [], bcc: [], subject: '', text: '' }
}

const prefixed = (prefix: string, subject: string) =>
  new RegExp(`^${prefix}:`, 'i').test(subject.trim()) ? subject : `${prefix}: ${subject}`

const sameEmail = (a: Address, b: Address) => a.email.toLowerCase() === b.email.toLowerCase()

function uniqueExcept(list: Address[], skip: (a: Address) => boolean): Address[] {
  const out: Address[] = []
  for (const a of list) if (!skip(a) && !out.some((o) => sameEmail(o, a))) out.push(a)
  return out
}

/**
 * Reply, reply all or forward the latest message of a thread. Replies go to Reply-To (or the
 * sender); when the latest message is Zach's own, they go back to its recipients.
 */
export function replyDraft(
  detail: ThreadDetail,
  kind: Exclude<ComposeKind, 'new'>,
  own: ReadonlySet<string>,
  body?: string,
): Draft {
  const msgs = detail.messages
  const mine = (a: Address | null) => !!a && own.has(a.email.toLowerCase())
  // Answer the latest message from someone else, or the latest at all.
  const m: MessageRow = [...msgs].reverse().find((x) => !mine(x.from)) ?? msgs[msgs.length - 1]!
  const base = {
    id: uuid(),
    kind,
    accountId: detail.thread.accountId,
    threadId: detail.thread.id,
    bcc: [],
    text: '',
  }
  if (kind === 'forward')
    return {
      ...base,
      to: [],
      cc: [],
      subject: prefixed('Fwd', m.subject || detail.thread.subject),
      quoted: forwardHeader(m) + (body ?? ''),
    }
  const fromMe = mine(m.from)
  const primary = fromMe ? m.to : m.replyTo.length ? m.replyTo : m.from ? [m.from] : []
  const to = uniqueExcept(primary, mine)
  const cc =
    kind === 'replyAll'
      ? uniqueExcept(
          [...(fromMe ? [] : m.to), ...m.cc],
          (a) => mine(a) || to.some((t) => sameEmail(t, a)),
        )
      : []
  return {
    ...base,
    to: to.length ? to : primary.slice(0, 1),
    cc,
    subject: prefixed('Re', m.subject || detail.thread.subject),
    replyToMessageId: m.id,
  }
}

function forwardHeader(m: MessageRow): string {
  const who = (list: Address[]) =>
    list.map((a) => escapeHtml(a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
  return (
    `<p>---------- Forwarded message ---------<br>` +
    `From: ${m.from ? who([m.from]) : ''}<br>` +
    `Date: ${escapeHtml(longTime(m.date))}<br>` +
    `Subject: ${escapeHtml(m.subject)}<br>` +
    `To: ${who(m.to)}</p>`
  )
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** Plain text → minimal HTML: paragraphs on blank lines, <br> on single newlines, links kept. */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function html(d: Draft): string {
  const body = textToHtml(d.text)
  return d.quoted ? `${body}<br><blockquote>${d.quoted}</blockquote>` : body
}

export function toDraftRequest(d: Draft): DraftRequest {
  return {
    accountId: d.accountId,
    to: d.to,
    cc: d.cc,
    bcc: d.bcc,
    subject: d.subject,
    html: html(d),
    ...(d.replyToMessageId ? { replyToMessageId: d.replyToMessageId } : {}),
  }
}

export function toSendRequest(d: Draft, undoMs: number, draftSaved: boolean): SendRequest {
  return {
    ...toDraftRequest(d),
    id: uuid(),
    undoMs,
    ...(draftSaved ? { draftId: d.id } : {}),
  }
}

/** A draft with nothing typed in it is not worth saving. */
export const isEmpty = (d: Draft) =>
  !d.text.trim() && !d.subject.trim() && !d.to.length && !d.cc.length && !d.bcc.length

export const recipientCount = (d: Draft) => d.to.length + d.cc.length + d.bcc.length

/** Parses what someone typed or pasted into a recipient field: "Ana <a@b.c>, x@y.z". */
export function parseAddresses(input: string): Address[] {
  const out: Address[] = []
  for (const part of input.split(/[,;\n]+/)) {
    const s = part.trim()
    if (!s) continue
    const m = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(s)
    if (m) {
      const name = m[1]!.replace(/^"|"$/g, '').trim()
      out.push(name ? { name, email: m[2]! } : { email: m[2]! })
    } else if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) out.push({ email: s })
  }
  return out
}
