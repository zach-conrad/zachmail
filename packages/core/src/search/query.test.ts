import { describe, expect, it } from 'vitest'
import {
  highlightRanges,
  parseQuery,
  planQuery,
  toFts5,
  toGmailQuery,
  toTsQuery,
  tokenize,
  type SearchContext,
} from './query'

const UTC = { tzOffset: 0, now: Date.UTC(2026, 9, 14) }
const p = (q: string) => parseQuery(q, UTC)

const ctx: SearchContext = {
  accounts: [
    { id: 'a1', email: 'zach@gmail.com', shortName: 'Personal', displayName: null },
    { id: 'a2', email: 'zach@work.dev', shortName: 'Work', displayName: 'Work mail' },
  ],
  folders: [
    { id: 'in1', accountId: 'a1', name: 'INBOX', kind: 'inbox' },
    { id: 'in2', accountId: 'a2', name: 'Inbox', kind: 'inbox' },
    { id: 'tr1', accountId: 'a1', name: 'TRASH', kind: 'trash' },
    { id: 'sp1', accountId: 'a1', name: 'SPAM', kind: 'spam' },
    { id: 'l1', accountId: 'a1', name: 'Work/Clients', kind: 'custom' },
    { id: 'l2', accountId: 'a1', name: 'Receipts', kind: 'custom' },
  ],
}
const HIDE = { ids: ['tr1', 'sp1'], negated: true }

describe('tokenize', () => {
  it('splits on anything but letters and digits, lowercased', () => {
    expect(tokenize('Ana@X.com  Café-Bar 12ab')).toEqual(['ana', 'x', 'com', 'café', 'bar', '12ab'])
  })
})

describe('parseQuery', () => {
  it('parses operators, phrases and negation', () => {
    const q = p('from:ana "q4 plan" -subject:draft has:attachment is:unread budget')
    expect(q.providerOnly).toBe(false)
    expect(q.clauses).toEqual([
      { kind: 'match', field: 'from', value: 'ana', phrase: false, negated: false },
      { kind: 'match', field: 'any', value: 'q4 plan', phrase: true, negated: false },
      { kind: 'match', field: 'subject', value: 'draft', phrase: false, negated: true },
      { kind: 'flag', flag: 'attachment', value: true },
      { kind: 'flag', flag: 'unread', value: true },
      { kind: 'match', field: 'any', value: 'budget', phrase: false, negated: false },
    ])
  })

  it('quoted operator values and cc/bcc as recipients', () => {
    expect(p('from:"Ana Ruiz" cc:bob').clauses).toEqual([
      { kind: 'match', field: 'from', value: 'Ana Ruiz', phrase: true, negated: false },
      { kind: 'match', field: 'to', value: 'bob', phrase: false, negated: false },
    ])
  })

  it('is:read, -is:starred and -has:attachment', () => {
    expect(p('is:read -is:starred -has:attachment').clauses).toEqual([
      { kind: 'flag', flag: 'unread', value: false },
      { kind: 'flag', flag: 'starred', value: false },
      { kind: 'flag', flag: 'attachment', value: false },
    ])
  })

  it('dates in the client time zone, inclusive after and exclusive before', () => {
    const q = parseQuery('after:2026/10/01 before:10/05/2026', { tzOffset: 420 })
    expect(q.clauses).toEqual([
      { kind: 'date', bound: 'after', at: Date.UTC(2026, 9, 1, 7) },
      { kind: 'date', bound: 'before', at: Date.UTC(2026, 9, 5, 7) },
    ])
    expect(p('newer_than:2d').clauses).toEqual([
      { kind: 'date', bound: 'after', at: UTC.now - 2 * 86_400_000 },
    ])
    expect(p('-before:2026-01-01').clauses[0]).toMatchObject({ bound: 'after' })
    expect(p('before:yesterday').clauses).toEqual([])
  })

  it('keeps provider-only operators verbatim', () => {
    const q = p('larger:5M filename:pdf invoice')
    expect(q.providerOnly).toBe(true)
    expect(q.clauses.filter((c) => c.kind === 'raw')).toEqual([
      { kind: 'raw', text: 'larger:5M' },
      { kind: 'raw', text: 'filename:pdf' },
    ])
    expect(p('a OR b').providerOnly).toBe(true)
  })

  it('treats unknown operators and urls as text, and ignores half-typed operators', () => {
    expect(p('re: https://x.com/a from:').clauses.map((c) => c.kind)).toEqual(['match', 'match'])
  })
})

describe('planQuery', () => {
  it('resolves labels, in:, accounts and hides trash and spam by default', () => {
    const plan = planQuery(p('label:work-clients in:inbox account:work'), ctx)!
    expect(plan.folders).toEqual([
      { ids: ['l1'], negated: false },
      { ids: ['in1', 'in2'], negated: false },
      HIDE,
    ])
    expect(plan.accountIds).toEqual(['a2'])
  })

  it('in:done is out of the inbox; in:trash and in:anywhere search everywhere', () => {
    expect(planQuery(p('in:done'), ctx)!.folders).toEqual([
      { ids: ['in1', 'in2'], negated: true },
      HIDE,
    ])
    expect(planQuery(p('in:trash'), ctx)!.folders).toEqual([{ ids: ['tr1'], negated: false }])
    expect(planQuery(p('in:anywhere x'), ctx)!.folders).toEqual([])
  })

  it('returns null when nothing can match', () => {
    expect(planQuery(p('label:nope'), ctx)).toBeNull()
    expect(planQuery(p('account:nope'), ctx)).toBeNull()
    expect(planQuery(p('is:unread is:read'), ctx)).toBeNull()
    expect(planQuery(p('after:2026/10/05 before:2026/10/01'), ctx)).toBeNull()
    expect(planQuery(p('-label:nope x'), ctx)).not.toBeNull()
  })

  it('from:me means any of my addresses', () => {
    const plan = planQuery(p('from:me'), ctx)!
    expect(plan.match).toEqual([
      {
        field: 'from',
        alts: [
          ['zach', 'gmail', 'com'],
          ['zach', 'work', 'dev'],
        ],
        prefix: false,
        negated: false,
      },
    ])
    expect(plan.highlight).toEqual([])
  })
})

describe('compilers', () => {
  const plan = planQuery(p('from:ana@x.com "q4 plan" -draft subject:budget'), ctx)!

  it('tsquery with weights, phrases, prefixes and negation', () => {
    expect(toTsQuery(plan.match)).toBe(
      `('ana':B <-> 'x':B <-> 'com':*B) & ('q4' <-> 'plan') & !'draft':* & 'budget':*A`,
    )
  })

  it('FTS5 expressions per term', () => {
    expect(plan.match.map(toFts5)).toEqual([
      'sender : ("ana x com"*)',
      '"q4 plan"',
      '"draft"*',
      'subject : ("budget"*)',
    ])
    expect(toFts5(planQuery(p('to:me'), ctx)!.match[0]!)).toBe(
      'recipients : ("zach gmail com" OR "zach work dev")',
    )
  })

  it('Gmail q= with the mirror horizon', () => {
    expect(
      toGmailQuery(p('from:"Ana R" in:done -is:starred account:work larger:5M after:2026/10/01'), {
        before: Date.UTC(2026, 0, 1),
      }),
    ).toBe(
      `from:"Ana R" -in:inbox -is:starred larger:5M after:${Date.UTC(2026, 9, 1) / 1000} before:${Date.UTC(2026, 0, 1) / 1000}`,
    )
  })
})

describe('highlightRanges', () => {
  it('marks word prefixes', () => {
    expect(highlightRanges('Q4 Planning — plan B', ['plan', 'q4'])).toEqual([
      [0, 2],
      [3, 7],
      [14, 18],
    ])
  })
})
