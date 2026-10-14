/**
 * Snippets: saved templates the composer expands in place. Typed as `;shortcut` in the body or
 * picked with ⌘; (design §3.4). Everything here is pure and runs on the replica, so expanding
 * a snippet never waits on the network.
 */
import type { Address } from '../sync/protocol'

/** Synced to every replica as the `snippet` entity. Ids are client UUIDs so offline edits keep them. */
export interface SnippetRow {
  id: string
  /** Shown in the picker, e.g. "Intro call". */
  name: string
  /** Typed after `;` to expand, e.g. "call". Lowercase; '' means picker only. */
  shortcut: string
  /** Applied when the draft's subject is still empty; '' leaves the subject alone. */
  subject: string
  html: string
  /** Added to the draft's Cc / Bcc. */
  cc: Address[]
  bcc: Address[]
  updatedAt: number
}

/** PUT /api/snippets/:id body. */
export type SnippetInput = Omit<SnippetRow, 'id' | 'updatedAt'>

export const MAX_SNIPPETS = 500
export const MAX_SNIPPET_HTML = 100_000
export const SHORTCUT = /^[a-z0-9][a-z0-9_-]{0,31}$/

export class InvalidSnippetError extends Error {
  override name = 'InvalidSnippetError'
}

function fail(msg: string): never {
  throw new InvalidSnippetError(msg)
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+$/

function addresses(v: unknown, field: string): Address[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 50) fail(`${field} must be a list of addresses`)
  return v.map((a: unknown, i) => {
    const { email, name } = (a ?? {}) as { email?: unknown; name?: unknown }
    if (typeof email !== 'string' || !EMAIL.test(email)) fail(`${field}[${i}].email is invalid`)
    if (name !== undefined && typeof name !== 'string') fail(`${field}[${i}].name is invalid`)
    return name ? { email, name } : { email }
  })
}

/** Validates an untrusted snippet body. The shortcut is lowercased. */
export function parseSnippetInput(body: unknown): SnippetInput {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 100)
    fail('name must be 1-100 characters')
  const shortcut = b.shortcut ?? ''
  if (typeof shortcut !== 'string') fail('shortcut is invalid')
  const sc = shortcut.trim().toLowerCase()
  if (sc && !SHORTCUT.test(sc)) fail('shortcut must be letters, digits, - or _ (up to 32)')
  const subject = b.subject ?? ''
  if (typeof subject !== 'string' || subject.length > 998) fail('subject is invalid')
  if (typeof b.html !== 'string' || b.html.length > MAX_SNIPPET_HTML) fail('html is invalid')
  return {
    name: b.name.trim(),
    shortcut: sc,
    subject,
    html: b.html,
    cc: addresses(b.cc, 'cc'),
    bcc: addresses(b.bcc, 'bcc'),
  }
}

// ---- Variables ----

/** What `{first_name}` and friends expand to. */
export interface SnippetContext {
  /** The draft's To recipients; `{first_name}` etc. name all of them ("Ana and Ben"). */
  to: Address[]
  /** The sending identity. */
  from?: Address
  /** For `{date}` / `{day}`; defaults to now. */
  now?: Date
  locale?: string
}

export interface ExpandedSnippet {
  subject: string
  html: string
  cc: Address[]
  bcc: Address[]
  /** Variables with no value and no `|fallback`; the composer can point them out. */
  missing: string[]
}

/** Splits a display name into first / last, handling "Last, First" and quotes. */
export function splitName(a: Address): { first: string; last: string; full: string } {
  let name = (a.name ?? '').replace(/^["']|["']$/g, '').trim()
  if (name.includes('@')) name = ''
  if (name.includes(',')) {
    const [last = '', first = ''] = name.split(',', 2).map((s) => s.trim())
    name = `${first} ${last}`.trim()
  }
  if (!name) {
    // ana.lopez@ / ana_lopez@ / ana@ → "Ana Lopez" / "Ana"
    const local = a.email.split('@')[0] ?? ''
    if (/^[a-z]+([._-][a-z]+)?$/i.test(local))
      name = local
        .split(/[._-]/)
        .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
        .join(' ')
  }
  const parts = name.split(/\s+/).filter(Boolean)
  return { first: parts[0] ?? '', last: parts.length > 1 ? parts.at(-1)! : '', full: name }
}

/** "Ana", "Ana and Ben", "Ana, Ben and Cy". */
function joinNames(names: string[]): string {
  const n = names.filter(Boolean)
  if (n.length <= 1) return n[0] ?? ''
  return `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`
}

function variables(ctx: SnippetContext): Record<string, string> {
  const people = ctx.to.map(splitName)
  const me = ctx.from ? splitName(ctx.from) : null
  const now = ctx.now ?? new Date()
  return {
    first_name: joinNames(people.map((p) => p.first)),
    last_name: joinNames(people.map((p) => p.last)),
    full_name: joinNames(people.map((p) => p.full)),
    name: joinNames(people.map((p) => p.full)),
    email: ctx.to.map((a) => a.email).join(', '),
    my_first_name: me?.first ?? '',
    my_name: me?.full ?? '',
    my_email: ctx.from?.email ?? '',
    date: now.toLocaleDateString(ctx.locale, { month: 'long', day: 'numeric' }),
    day: now.toLocaleDateString(ctx.locale, { weekday: 'long' }),
  }
}

// {first_name} or {first_name|there}; names are case-insensitive, spaces allowed inside.
const VAR = /\{\s*([a-z_]+)\s*(?:\|([^{}]*))?\}/gi

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

function fill(
  text: string,
  vars: Record<string, string>,
  missing: Set<string>,
  esc: (s: string) => string,
) {
  return text.replace(VAR, (whole, rawName: string, fallback: string | undefined) => {
    const name = rawName.toLowerCase()
    if (!(name in vars)) return whole
    const v = vars[name]!
    if (v) return esc(v)
    if (fallback !== undefined) return esc(fallback.trim())
    missing.add(name)
    return ''
  })
}

/** Expands a snippet's variables for the current draft. */
export function expandSnippet(s: SnippetRow, ctx: SnippetContext): ExpandedSnippet {
  const vars = variables(ctx)
  const missing = new Set<string>()
  return {
    subject: fill(s.subject, vars, missing, (v) => v),
    html: fill(s.html, vars, missing, escapeHtml),
    cc: s.cc,
    bcc: s.bcc,
    missing: [...missing],
  }
}

/** Adds addresses not already on the draft (case-insensitive), keeping order. */
export function mergeAddresses(current: Address[], add: Address[], skip: Address[] = []) {
  const seen = new Set([...current, ...skip].map((a) => a.email.toLowerCase()))
  const out = [...current]
  for (const a of add) {
    const k = a.email.toLowerCase()
    if (!seen.has(k)) {
      seen.add(k)
      out.push(a)
    }
  }
  return out
}

// ---- Finding snippets while typing ----

/**
 * The `;query` being typed just before the caret, if any. `;` must start the text or follow
 * whitespace, so "a;b" in prose never opens the menu.
 */
export function findSnippetTrigger(
  textBeforeCaret: string,
): { query: string; start: number } | null {
  const m = /(^|\s);([a-z0-9_-]{0,32})$/i.exec(textBeforeCaret)
  if (!m) return null
  return { query: m[2]!.toLowerCase(), start: m.index + m[1]!.length }
}

/** Snippets for a query, best first: exact shortcut, shortcut prefix, name word prefix, fuzzy. */
export function matchSnippets(
  query: string,
  snippets: readonly SnippetRow[],
  limit = 8,
): SnippetRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...snippets].sort(byName).slice(0, limit)
  const scored: { s: SnippetRow; score: number }[] = []
  for (const s of snippets) {
    const score = scoreSnippet(q, s)
    if (score > 0) scored.push({ s, score })
  }
  scored.sort((a, b) => b.score - a.score || byName(a.s, b.s))
  return scored.slice(0, limit).map((x) => x.s)
}

const byName = (a: SnippetRow, b: SnippetRow) => a.name.localeCompare(b.name)

function scoreSnippet(q: string, s: SnippetRow): number {
  const name = s.name.toLowerCase()
  if (s.shortcut === q) return 100
  if (s.shortcut.startsWith(q)) return 80 - s.shortcut.length / 100
  if (name.startsWith(q)) return 60
  if (name.split(/[\s_-]+/).some((w) => w.startsWith(q))) return 50
  if (name.includes(q)) return 30
  return isSubsequence(q, `${s.shortcut} ${name}`) ? 10 : 0
}

function isSubsequence(q: string, text: string) {
  let i = 0
  for (const c of text) if (c === q[i] && ++i === q.length) return true
  return false
}

/** The snippet a fully typed `;shortcut` names, for expand-on-space/tab. */
export function snippetForShortcut(
  shortcut: string,
  snippets: readonly SnippetRow[],
): SnippetRow | undefined {
  const k = shortcut.toLowerCase()
  return k ? snippets.find((s) => s.shortcut === k) : undefined
}
