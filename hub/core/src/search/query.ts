/**
 * The search language (design §3.5): Gmail-style operators parsed once here and compiled to
 * SQLite FTS5 (clients), Postgres full-text search (server) and the Gmail `q=` / Outlook KQL
 * syntax (fallback for mail older than the mirror).
 *
 * Matching is per message, like Gmail: a thread is a result when one of its messages satisfies
 * every message-level clause. Folders, labels and accounts are thread-level.
 */
import type { FolderKind } from '../sync/protocol'

export type TextField = 'any' | 'subject' | 'from' | 'to'

export type Clause =
  /** Free text, or a `from:` / `to:` / `subject:` value. `phrase` when it was quoted. */
  | { kind: 'match'; field: TextField; value: string; phrase: boolean; negated: boolean }
  | { kind: 'in'; value: string; negated: boolean }
  | { kind: 'label'; value: string; negated: boolean }
  | { kind: 'account'; value: string; negated: boolean }
  | { kind: 'flag'; flag: 'unread' | 'starred' | 'attachment'; value: boolean }
  /** Message date bounds, epoch ms. `after` is inclusive, `before` exclusive (as in Gmail). */
  | { kind: 'date'; bound: 'before' | 'after'; at: number }
  /** A Gmail operator we cannot evaluate locally (size:, filename:, OR, …); kept verbatim. */
  | { kind: 'raw'; text: string }

export interface ParsedQuery {
  clauses: Clause[]
  /** At least one clause only the provider can evaluate: skip local search, ask the provider. */
  providerOnly: boolean
}

export interface ParseOptions {
  /** For relative dates (`newer_than:2d`). Defaults to Date.now(). */
  now?: number
  /** Minutes west of UTC, as Date#getTimezoneOffset returns; dates mean local midnight. */
  tzOffset?: number
}

/** Gmail operators we pass through to the provider untouched. */
const PROVIDER_ONLY = new Set([
  'filename',
  'larger',
  'smaller',
  'size',
  'list',
  'deliveredto',
  'category',
  'rfc822msgid',
  'around',
])

const FIELD_OPS: Record<string, TextField> = {
  from: 'from',
  to: 'to',
  cc: 'to',
  bcc: 'to',
  subject: 'subject',
}

/** Splits text into the tokens both indexes store: lowercase runs of letters and digits. */
export function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

export function parseQuery(input: string, opts: ParseOptions = {}): ParsedQuery {
  const now = opts.now ?? Date.now()
  const tz = opts.tzOffset ?? new Date(now).getTimezoneOffset()
  const clauses: Clause[] = []
  let providerOnly = false
  const raw = (text: string) => {
    clauses.push({ kind: 'raw', text })
    providerOnly = true
  }

  for (const w of words(input)) {
    const negated = w.text.startsWith('-') && w.text.length > 1
    const body = negated ? w.text.slice(1) : w.text
    if (w.quoted) {
      if (tokenize(body).length)
        clauses.push({ kind: 'match', field: 'any', value: body, phrase: true, negated })
      continue
    }
    if (body === 'OR' || body === 'AND' || /^[{}()]|[{}()]$/.test(body)) {
      if (body !== 'AND') raw(w.text)
      continue
    }

    const colon = body.indexOf(':')
    const op = colon > 0 ? body.slice(0, colon).toLowerCase() : ''
    const value = colon > 0 ? body.slice(colon + 1) : ''
    const quotedValue = colon > 0 && w.valueQuoted
    const neg = (c: Clause) => clauses.push(c)

    if (op in FIELD_OPS) {
      if (tokenize(value).length || value.toLowerCase() === 'me')
        neg({ kind: 'match', field: FIELD_OPS[op]!, value, phrase: quotedValue, negated })
    } else if (op === 'in' || op === 'label' || op === 'account') {
      if (value) neg({ kind: op, value: value.toLowerCase(), negated })
    } else if (op === 'is' || op === 'has') {
      const v = value.toLowerCase()
      const flag =
        op === 'has'
          ? v === 'attachment'
            ? 'attachment'
            : null
          : v === 'unread' || v === 'read'
            ? 'unread'
            : v === 'starred'
              ? 'starred'
              : null
      if (flag) neg({ kind: 'flag', flag, value: (v !== 'read') !== negated })
      else if (op === 'is' && v === 'important') neg({ kind: 'in', value: 'important', negated })
      else if (v) raw(w.text)
    } else if (op === 'before' || op === 'after' || op === 'older' || op === 'newer') {
      const at = parseDate(value, tz)
      if (at === null) continue
      const bound = op === 'before' || op === 'older' ? 'before' : 'after'
      // -before:X is after:X and vice versa.
      neg({ kind: 'date', bound: negated ? flip(bound) : bound, at })
    } else if (op === 'older_than' || op === 'newer_than') {
      const at = parseRelative(value, now)
      if (at === null) continue
      const bound = op === 'older_than' ? 'before' : 'after'
      neg({ kind: 'date', bound: negated ? flip(bound) : bound, at })
    } else if (PROVIDER_ONLY.has(op)) {
      if (value) raw(w.text)
    } else if (tokenize(body).length) {
      neg({ kind: 'match', field: 'any', value: body, phrase: false, negated })
    }
  }
  return { clauses, providerOnly }
}

const flip = (b: 'before' | 'after') => (b === 'before' ? 'after' : 'before')

interface Word {
  text: string
  /** The whole word was a quoted phrase. */
  quoted: boolean
  /** An `op:"…"` value was quoted. */
  valueQuoted: boolean
}

/** Whitespace-separated words; double quotes group (`"a b"`, `-"a b"`, `from:"Ana R"`). */
function words(input: string): Word[] {
  const out: Word[] = []
  const re = /(-?)"([^"]*)"?|(-?[^\s:"]+:)"([^"]*)"?|(\S+)/g
  for (const m of input.matchAll(re)) {
    if (m[2] !== undefined) out.push({ text: m[1] + m[2], quoted: true, valueQuoted: false })
    else if (m[3] !== undefined) out.push({ text: m[3] + m[4], quoted: false, valueQuoted: true })
    else out.push({ text: m[5]!, quoted: false, valueQuoted: false })
  }
  return out
}

/** YYYY/MM/DD, YYYY-MM-DD, MM/DD/YYYY or epoch seconds → local midnight (or that instant). */
export function parseDate(value: string, tzOffset: number): number | null {
  if (/^\d{9,11}$/.test(value)) return Number(value) * 1000
  let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value)
  let y: number, mo: number, d: number
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)))
    [y, mo, d] = [Number(m[3]), Number(m[1]), Number(m[2])]
  else return null
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return Date.UTC(y, mo - 1, d) + tzOffset * 60_000
}

/** `3d`, `2m`, `1y` before `now`. */
function parseRelative(value: string, now: number): number | null {
  const m = /^(\d+)([dmy])$/i.exec(value)
  if (!m) return null
  const n = Number(m[1])
  const d = new Date(now)
  const unit = m[2]!.toLowerCase()
  if (unit === 'd') return now - n * 86_400_000
  if (unit === 'm') d.setMonth(d.getMonth() - n)
  else d.setFullYear(d.getFullYear() - n)
  return d.getTime()
}

// ---- Planning: resolve names against the user's accounts and folders --------------------

export interface SearchContext {
  accounts: { id: string; email: string; shortName: string | null; displayName: string | null }[]
  folders: { id: string; accountId: string; name: string; kind: FolderKind }[]
}

/** One full-text condition: any of `alts` (token sequences) in `field`. */
export interface MatchTerm {
  field: TextField
  alts: string[][]
  /** The last token of each alternative may be a prefix (search as you type). */
  prefix: boolean
  negated: boolean
}

/**
 * A query resolved to ids, ready for a SQL compiler. `null` from planQuery means nothing can
 * match (e.g. an unknown label), so callers skip the query entirely.
 */
export interface SearchPlan {
  match: MatchTerm[]
  /** Thread must be in one of these accounts; null = any. */
  accountIds: string[] | null
  /** Each entry: the thread is (or with `negated`, is not) in at least one of `ids`. */
  folders: { ids: string[]; negated: boolean }[]
  unread?: boolean
  starred?: boolean
  attachment?: boolean
  /** Epoch ms bounds on the message date: after inclusive, before exclusive. */
  after?: number
  before?: number
  /** Positive tokens, for highlighting matches in results. */
  highlight: string[]
}

const KIND_ALIASES: Record<string, FolderKind | 'done' | 'anywhere'> = {
  inbox: 'inbox',
  sent: 'sent',
  draft: 'drafts',
  drafts: 'drafts',
  trash: 'trash',
  bin: 'trash',
  spam: 'spam',
  starred: 'starred',
  important: 'important',
  done: 'done',
  archive: 'done',
  archived: 'done',
  anywhere: 'anywhere',
  all: 'anywhere',
}

/** Gmail writes nested labels and spaces as hyphens in `label:` (Work/Clients → work-clients). */
const labelKey = (s: string) => s.toLowerCase().replace(/[\s/]+/g, '-')

export function planQuery(q: ParsedQuery, ctx: SearchContext): SearchPlan | null {
  const plan: SearchPlan = { match: [], accountIds: null, folders: [], highlight: [] }
  const ownEmails = ctx.accounts.map((a) => a.email.toLowerCase())
  const foldersOfKind = (kinds: FolderKind[]) =>
    ctx.folders.filter((f) => kinds.includes(f.kind)).map((f) => f.id)
  let searchTrashSpam = false

  for (const c of q.clauses) {
    switch (c.kind) {
      case 'match': {
        const me = (c.field === 'from' || c.field === 'to') && c.value.toLowerCase() === 'me'
        const alts = me ? ownEmails.map(tokenize) : [tokenize(c.value)]
        if (!alts.length) {
          if (c.negated) continue
          return null
        }
        const prefix = !c.phrase && !me
        // A word just begun after other terms would only empty the list for a keystroke; it
        // counts once it is long enough to be a prefix.
        const typing = prefix && !c.negated && c === q.clauses.at(-1) && q.clauses.length > 1
        if (
          typing &&
          alts.length === 1 &&
          alts[0]!.length === 1 &&
          alts[0]![0]!.length < MIN_PREFIX
        )
          continue
        plan.match.push({ field: c.field, alts, prefix, negated: c.negated })
        break
      }
      case 'in': {
        const kind = KIND_ALIASES[c.value]
        if (kind === 'anywhere') {
          searchTrashSpam = true
          continue
        }
        if (kind === 'trash' || kind === 'spam') searchTrashSpam = true
        if (kind === 'done') {
          // Done = archived: out of the inbox (trash and spam stay excluded below).
          plan.folders.push({ ids: foldersOfKind(['inbox']), negated: !c.negated })
          continue
        }
        const ids = kind ? foldersOfKind([kind]) : labelIds(ctx, c.value)
        if (!pushFolders(plan, ids, c.negated)) return null
        break
      }
      case 'label': {
        if (!pushFolders(plan, labelIds(ctx, c.value), c.negated)) return null
        break
      }
      case 'account': {
        const v = c.value
        const hit = ctx.accounts
          .filter(
            (a) =>
              a.shortName?.toLowerCase() === v ||
              a.displayName?.toLowerCase() === v ||
              a.email.toLowerCase() === v ||
              a.email.toLowerCase().split('@')[0] === v,
          )
          .map((a) => a.id)
        const allowed = c.negated
          ? ctx.accounts.map((a) => a.id).filter((id) => !hit.includes(id))
          : hit
        plan.accountIds = plan.accountIds
          ? plan.accountIds.filter((id) => allowed.includes(id))
          : allowed
        if (!plan.accountIds.length) return null
        break
      }
      case 'flag': {
        const prev = plan[c.flag]
        if (prev !== undefined && prev !== c.value) return null
        plan[c.flag] = c.value
        break
      }
      case 'date': {
        if (c.bound === 'after') plan.after = Math.max(plan.after ?? -Infinity, c.at)
        else plan.before = Math.min(plan.before ?? Infinity, c.at)
        break
      }
      case 'raw':
        break
    }
  }
  if (plan.after !== undefined && plan.before !== undefined && plan.after >= plan.before)
    return null
  if (!searchTrashSpam) {
    const hidden = foldersOfKind(['trash', 'spam'])
    if (hidden.length) plan.folders.push({ ids: hidden, negated: true })
  }
  plan.highlight = highlightTokens(q)
  return plan
}

function labelIds(ctx: SearchContext, value: string): string[] {
  const key = labelKey(value)
  return ctx.folders.filter((f) => labelKey(f.name) === key).map((f) => f.id)
}

/** False when a positive folder condition can never match. */
function pushFolders(plan: SearchPlan, ids: string[], negated: boolean): boolean {
  if (!ids.length) return negated
  plan.folders.push({ ids, negated })
  return true
}

/**
 * Hub search (ZACHHUB_PLAN.md §5): `in:<module>` picks modules (`in:tasks`, `-in:mail`) rather
 * than a mail folder, so a module name shadows a mail label of the same name. Several positive
 * ones mean any of them. Returns the modules in scope (a subset of `known`, in its order) and
 * the query without those clauses, for planQuery.
 */
export function moduleScope(
  q: ParsedQuery,
  known: readonly string[],
): { modules: string[]; query: ParsedQuery } {
  const include = new Set<string>()
  const exclude = new Set<string>()
  const clauses = q.clauses.filter((c) => {
    if (c.kind !== 'in' || !known.includes(c.value)) return true
    ;(c.negated ? exclude : include).add(c.value)
    return false
  })
  const modules = known.filter((m) => (!include.size || include.has(m)) && !exclude.has(m))
  return { modules, query: { ...q, clauses } }
}

/** A query worth running: something that narrows the results. */
export const isSearchable = (q: ParsedQuery) => q.clauses.length > 0

// ---- Compilers for the full-text part ---------------------------------------------------

const PG_WEIGHT: Record<TextField, string> = { any: '', subject: 'A', from: 'B', to: 'C' }

/**
 * A one- or two-letter prefix matches much of a mailbox and costs a scan of it, for results
 * nobody wants; it matches only that word until a third letter is typed.
 */
const MIN_PREFIX = 3
const isPrefix = (t: MatchTerm, last: string) => t.prefix && last.length >= MIN_PREFIX

/**
 * Postgres tsquery text for the match terms, against a tsvector built from the same
 * `tokenize` rules with weights A subject, B sender, C recipients, D body. Empty when there is
 * no full-text condition. Tokens are letters and digits only, so quoting cannot be broken.
 */
export function toTsQuery(terms: MatchTerm[]): string {
  return terms
    .map((t) => {
      const w = PG_WEIGHT[t.field]
      const alt = (tokens: string[]) =>
        tokens
          .map((tok, i) => {
            const star = i === tokens.length - 1 && isPrefix(t, tok) ? '*' : ''
            return star || w ? `'${tok}':${star}${w}` : `'${tok}'`
          })
          .join(' <-> ')
      const expr = t.alts.map(alt).join(' | ')
      const grouped = t.alts.length > 1 || t.alts[0]!.length > 1 ? `(${expr})` : expr
      return t.negated ? `!${grouped}` : grouped
    })
    .join(' & ')
}

const FTS5_COLUMN: Record<TextField, string | null> = {
  any: null,
  subject: 'subject',
  from: 'sender',
  to: 'recipients',
}

/** One FTS5 MATCH expression for a term (negation is applied by the caller with NOT IN). */
export function toFts5(term: MatchTerm): string {
  const alt = (tokens: string[]) =>
    `"${tokens.join(' ')}"${isPrefix(term, tokens.at(-1)!) ? '*' : ''}`
  const expr = term.alts.map(alt).join(' OR ')
  const col = FTS5_COLUMN[term.field]
  if (!col) return term.alts.length > 1 ? `(${expr})` : expr
  return `${col} : (${expr})`
}

// ---- Gmail -------------------------------------------------------------------------------

/**
 * The Gmail `q=` for a parsed query. Accounts are applied by choosing which accounts to ask;
 * `before` (epoch ms) narrows to mail older than the mirror so pages aren't spent on threads
 * we already have.
 */
export function toGmailQuery(q: ParsedQuery, opts: { before?: number } = {}): string {
  const parts: string[] = []
  const quote = (s: string) => (/[\s"()]/.test(s) ? `"${s.replace(/"/g, '')}"` : s)
  for (const c of q.clauses) {
    const not = 'negated' in c && c.negated ? '-' : ''
    switch (c.kind) {
      case 'match': {
        const v = c.phrase ? `"${c.value.replace(/"/g, '')}"` : quote(c.value)
        parts.push(c.field === 'any' ? `${not}${v}` : `${not}${c.field}:${v}`)
        break
      }
      case 'in':
        if (KIND_ALIASES[c.value] === 'done') parts.push(`${not ? '' : '-'}in:inbox`)
        else if (KIND_ALIASES[c.value] === 'important') parts.push(`${not}is:important`)
        else parts.push(`${not}in:${quote(c.value)}`)
        break
      case 'label':
        parts.push(`${not}label:${quote(c.value)}`)
        break
      case 'account':
        break
      case 'flag':
        if (c.flag === 'attachment') parts.push(`${c.value ? '' : '-'}has:attachment`)
        else if (c.flag === 'unread') parts.push(c.value ? 'is:unread' : 'is:read')
        else parts.push(`${c.value ? '' : '-'}is:starred`)
        break
      case 'date':
        parts.push(`${c.bound}:${Math.floor(c.at / 1000)}`)
        break
      case 'raw':
        parts.push(c.text)
        break
    }
  }
  if (opts.before !== undefined) parts.push(`before:${Math.floor(opts.before / 1000)}`)
  return parts.join(' ')
}

/**
 * The Outlook `$search` (KQL) for a parsed query, or null when it uses something KQL on mail
 * cannot express (folders, labels, read or flagged state, `me`, Gmail-only operators): then
 * the account is not asked rather than answered with a wider set. Dates are whole UTC days.
 */
export function toGraphSearch(q: ParsedQuery, opts: { before?: number } = {}): string | null {
  const parts: string[] = []
  const day = (at: number) => new Date(at).toISOString().slice(0, 10)
  const FIELD: Record<TextField, string> = {
    any: '',
    subject: 'subject:',
    from: 'from:',
    to: 'recipients:',
  }
  for (const c of q.clauses) {
    switch (c.kind) {
      case 'match': {
        if (c.field !== 'any' && c.field !== 'subject' && c.value.toLowerCase() === 'me')
          return null
        const words = tokenize(c.value)
        if (!words.length) break
        const v = words.length > 1 || c.phrase ? `"${words.join(' ')}"` : words[0]!
        parts.push(`${c.negated ? 'NOT ' : ''}${FIELD[c.field]}${v}`)
        break
      }
      case 'account':
        break
      case 'flag':
        if (c.flag !== 'attachment') return null
        parts.push(`hasAttachments:${c.value}`)
        break
      case 'date':
        parts.push(`received${c.bound === 'after' ? '>=' : '<'}${day(c.at)}`)
        break
      default:
        return null
    }
  }
  // Rounded up so a horizon mid-day still reaches it; the overlap is already mirrored.
  if (opts.before !== undefined) parts.push(`received<${day(opts.before + 86_400_000)}`)
  return parts.length ? parts.join(' AND ') : null
}

// ---- Highlighting ------------------------------------------------------------------------

/** Tokens of the positive text conditions (not `from:me`), for highlighting results. */
export function highlightTokens(q: ParsedQuery): string[] {
  const out = new Set<string>()
  for (const c of q.clauses)
    if (c.kind === 'match' && !c.negated && c.value.toLowerCase() !== 'me')
      for (const t of tokenize(c.value)) out.add(t)
  return [...out]
}

/**
 * [start, end) ranges of words in `text` that start with one of `tokens` (as produced by
 * `planQuery().highlight`), for rendering matches in subjects and snippets.
 */
export function highlightRanges(text: string, tokens: readonly string[]): [number, number][] {
  if (!tokens.length) return []
  const out: [number, number][] = []
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0].toLowerCase()
    const hit = tokens.find((t) => word.startsWith(t))
    if (hit) out.push([m.index, m.index + hit.length])
  }
  return out
}
