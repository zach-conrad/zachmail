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

// ---- Split rules -------------------------------------------------------------------------

/**
 * Wire row for one user rule (server table `split_rules`). Rules run in `position` order
 * before the built-in classifier; the first match wins. A rule whose target is 'custom' is
 * its own split: a tab named `name`, keyed by the rule id.
 */
export interface SplitRuleRow {
  id: string
  name: string
  target: SplitId | 'custom'
  match: 'all' | 'any'
  conditions: SplitCondition[]
  position: number
}

/**
 * from     sender address contains value      ("@stripe.com", "ana@")
 * domain   sender domain is value or a subdomain of it
 * to       any recipient address contains value
 * subject  subject contains value
 * account  thread is in the account with this id
 * label    thread has the folder/label with this id
 */
export type SplitField = 'from' | 'domain' | 'to' | 'subject' | 'account' | 'label'
export const SPLIT_FIELDS: readonly SplitField[] = [
  'from',
  'domain',
  'to',
  'subject',
  'account',
  'label',
]

export interface SplitCondition {
  field: SplitField
  value: string
}

/** A built-in split id, or the id of a custom split rule. */
export type SplitKey = string

/** Everything rules can look at, on top of what the built-in classifier needs. */
export interface SplitRuleInput extends SplitInput {
  accountId: string
  subject: string
  folderIds: readonly string[]
  /** Lowercased recipient addresses; only read when a rule tests `to` (see `needsRecipients`). */
  recipients?: readonly string[]
}

export interface CompiledSplitRules {
  readonly rules: readonly SplitRuleRow[]
  /** Whether any rule tests recipients, so callers can skip gathering them. */
  readonly needsRecipients: boolean
  test(t: SplitRuleInput): SplitKey | null
}

type Test = (t: SplitRuleInput, from: string) => boolean

function compileCondition(c: SplitCondition): Test {
  const v = c.value.trim().toLowerCase()
  switch (c.field) {
    case 'from':
      return (_t, from) => from.includes(v)
    case 'domain': {
      const d = v.replace(/^@/, '')
      return (_t, from) => {
        const host = from.slice(from.lastIndexOf('@') + 1)
        return from.includes('@') && (host === d || host.endsWith('.' + d))
      }
    }
    case 'to':
      return (t) => !!t.recipients?.some((r) => r.includes(v))
    case 'subject':
      return (t) => t.subject.toLowerCase().includes(v)
    case 'account':
      return (t) => t.accountId === c.value
    case 'label':
      return (t) => t.folderIds.includes(c.value)
  }
}

export const sortSplitRules = (rules: readonly SplitRuleRow[]): SplitRuleRow[] =>
  [...rules].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))

/**
 * Turns rules into one function, once per rules change, so classifying 20k threads does no
 * per-thread parsing. Rules without conditions never match.
 */
export function compileSplitRules(rules: readonly SplitRuleRow[]): CompiledSplitRules {
  const sorted = sortSplitRules(rules)
  const compiled = sorted
    .filter((r) => r.conditions.length > 0)
    .map((r) => {
      const tests = r.conditions.map(compileCondition)
      const key: SplitKey = r.target === 'custom' ? r.id : r.target
      const matches: Test =
        r.match === 'any'
          ? (t, f) => tests.some((x) => x(t, f))
          : (t, f) => tests.every((x) => x(t, f))
      return { key, matches }
    })
  return {
    rules: sorted,
    needsRecipients: sorted.some((r) => r.conditions.some((c) => c.field === 'to')),
    test(t) {
      if (!t.folderKinds.includes('inbox')) return null
      const from = t.fromEmail?.toLowerCase() ?? ''
      for (const r of compiled) if (r.matches(t, from)) return r.key
      return classifySplit(t)
    },
  }
}

/** The split of one thread under `rules`; null when it is not in the inbox. */
export const evaluateSplit = (t: SplitRuleInput, rules: CompiledSplitRules): SplitKey | null =>
  rules.test(t)

/**
 * The sender splits are judged by: the newest of the thread's latest senders that is not one
 * of the user's own addresses, else the first participant. `senders` is newest first and may
 * contain nulls; client and server both pass the senders of the latest 5 messages.
 */
export function inboundSender(
  senders: readonly (string | null)[],
  ownEmails: ReadonlySet<string>,
  firstParticipant: string | null,
): string | null {
  for (const s of senders) if (s && !ownEmails.has(s)) return s
  return firstParticipant
}

export const BUILT_IN_SPLIT_LABELS: Record<SplitId, string> = {
  important: 'Important',
  other: 'Other',
  newsletters: 'Newsletters',
  notifications: 'Notifications',
}

export interface SplitTab {
  key: SplitKey
  label: string
  /** The rule behind a custom split. */
  ruleId?: string
}

/** Tabs in display order: the built-ins, then custom splits by position. */
export function splitTabs(rules: readonly SplitRuleRow[]): SplitTab[] {
  return [
    ...SPLIT_IDS.map((key) => ({ key, label: BUILT_IN_SPLIT_LABELS[key] })),
    ...sortSplitRules(rules)
      .filter((r) => r.target === 'custom')
      .map((r) => ({ key: r.id, label: r.name, ruleId: r.id })),
  ]
}

export const isBuiltInSplit = (k: string): k is SplitId =>
  (SPLIT_IDS as readonly string[]).includes(k)

// ---- Validation (API input) ---------------------------------------------------------------

export const SPLIT_RULE_LIMITS = { name: 40, value: 200, conditions: 20, rules: 100 } as const

export class InvalidSplitRuleError extends Error {
  override name = 'InvalidSplitRuleError'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** Validates an untrusted rule body (PUT /api/split-rules/:id); `id` comes from the path. */
export function parseSplitRule(id: string, body: unknown): SplitRuleRow {
  const bad = (msg: string): never => {
    throw new InvalidSplitRuleError(msg)
  }
  if (!isUuid(id)) bad('id must be a uuid')
  const b = (body ?? {}) as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : bad('name must be a string')
  if (!name || name.length > SPLIT_RULE_LIMITS.name) bad('name must be 1-40 characters')
  const target = b.target
  if (target !== 'custom' && !(typeof target === 'string' && isBuiltInSplit(target)))
    bad('target must be a built-in split or custom')
  if (b.match !== 'all' && b.match !== 'any') bad("match must be 'all' or 'any'")
  if (typeof b.position !== 'number' || !Number.isFinite(b.position))
    bad('position must be a number')
  if (!Array.isArray(b.conditions) || b.conditions.length > SPLIT_RULE_LIMITS.conditions)
    bad('conditions must be an array of at most 20')
  const conditions = (b.conditions as unknown[]).map((c) => {
    const x = (c ?? {}) as Record<string, unknown>
    if (!SPLIT_FIELDS.includes(x.field as SplitField)) bad('unknown condition field')
    if (typeof x.value !== 'string' || !x.value.trim() || x.value.length > SPLIT_RULE_LIMITS.value)
      bad('condition value must be 1-200 characters')
    return { field: x.field as SplitField, value: (x.value as string).trim() }
  })
  return {
    id: id.toLowerCase(),
    name,
    target: target as SplitRuleRow['target'],
    match: b.match as SplitRuleRow['match'],
    conditions,
    position: b.position as number,
  }
}
