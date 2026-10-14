import {
  expandSnippet,
  instantIntro,
  mergeAddresses,
  type Address,
  type MessageRow,
  type SnippetRow,
} from '@zachmail/core'
import type { Draft } from './draft'

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Snippet HTML → the composer's plain text: paragraphs become blank lines, tags drop. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? whole
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface SnippetResult {
  patch: Partial<Draft>
  /** Where the caret goes: the end of the inserted text. */
  caret: number
  /** Variables the snippet wanted but the draft could not fill. */
  missing: string[]
}

/**
 * Replaces text[start, end) (the typed `;query`, or an empty range at the caret) with the
 * expanded snippet; fills an empty subject and adds the snippet's Cc / Bcc.
 */
export function applySnippet(
  d: Draft,
  s: SnippetRow,
  start: number,
  end: number,
  from?: Address,
): SnippetResult {
  const out = expandSnippet(s, { to: d.to, ...(from ? { from } : {}) })
  const insert = htmlToText(out.html)
  const before = d.text.slice(0, start)
  const after = d.text.slice(end)
  const patch: Partial<Draft> = { text: before + insert + after }
  if (out.subject && !d.subject.trim()) patch.subject = out.subject
  if (out.cc.length) patch.cc = mergeAddresses(d.cc, out.cc, d.to)
  if (out.bcc.length) patch.bcc = mergeAddresses(d.bcc, out.bcc, [...d.to, ...d.cc])
  return { patch, caret: before.length + insert.length, missing: out.missing }
}

/** Instant intro on a plain-text reply draft; null when there is nobody to hand off to. */
export function applyIntro(
  d: Draft,
  replyTo: MessageRow,
  own: ReadonlySet<string>,
): Partial<Draft> | null {
  const out = instantIntro({ to: d.to, cc: d.cc, bcc: d.bcc, html: '' }, replyTo, own)
  if (!out) return null
  const line = htmlToText(out.html)
  const text = d.text.startsWith(line) ? d.text : `${line}\n\n${d.text}`
  return { to: out.to, cc: out.cc, bcc: out.bcc, text }
}
