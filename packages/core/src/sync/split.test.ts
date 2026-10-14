import { describe, expect, it } from 'vitest'
import {
  InvalidSplitRuleError,
  compileSplitRules,
  flushSplitRules,
  inboundSender,
  parseSplitRule,
  splitTabs,
  type SplitRuleInput,
  type SplitRuleRow,
} from './split'

const RULE_ID = '4b7a1c1e-0000-4000-8000-000000000001'

const input = (over: Partial<SplitRuleInput> = {}): SplitRuleInput => ({
  accountId: 'acc',
  subject: 'Hello',
  folderIds: ['f-inbox'],
  folderKinds: ['inbox'],
  accountHasImportant: false,
  hasListUnsubscribe: false,
  fromEmail: 'ana@example.com',
  ...over,
})

const rule = (over: Partial<SplitRuleRow> = {}): SplitRuleRow => ({
  id: RULE_ID,
  name: 'Stripe',
  target: 'custom',
  match: 'all',
  conditions: [{ field: 'domain', value: 'stripe.com' }],
  position: 0,
  ...over,
})

describe('split rules', () => {
  it('falls back to the built-in classifier', () => {
    const none = compileSplitRules([])
    expect(none.test(input())).toBe('important')
    expect(none.test(input({ hasListUnsubscribe: true }))).toBe('newsletters')
    expect(none.test(input({ folderKinds: [] }))).toBeNull()
  })

  it('runs user rules first, first match by position wins', () => {
    const rules = compileSplitRules([
      rule({
        id: 'b',
        target: 'other',
        position: 2,
        conditions: [{ field: 'from', value: 'ANA' }],
      }),
      rule({ id: 'a', position: 1 }),
    ])
    expect(
      rules.test(input({ fromEmail: 'billing@mail.stripe.com', hasListUnsubscribe: true })),
    ).toBe('a')
    expect(rules.test(input())).toBe('other')
    // A rule never pulls a thread out of Done.
    expect(rules.test(input({ folderKinds: ['archive'] }))).toBeNull()
  })

  it('matches every field', () => {
    const t = input({ subject: 'Your Invoice #12', recipients: ['zach@work.example'] })
    const one = (field: SplitRuleRow['conditions'][number]['field'], value: string) =>
      compileSplitRules([rule({ conditions: [{ field, value }] })]).test(t) === RULE_ID
    expect(one('from', '@example.com')).toBe(true)
    expect(one('domain', 'example.com')).toBe(true)
    expect(one('domain', 'ample.com')).toBe(false)
    expect(one('to', 'work.example')).toBe(true)
    expect(one('subject', 'invoice')).toBe(true)
    expect(one('account', 'acc')).toBe(true)
    expect(one('label', 'f-inbox')).toBe(true)
    expect(one('label', 'f-other')).toBe(false)
  })

  it("supports 'any', ignores empty rules and reports when recipients are needed", () => {
    const any = compileSplitRules([
      rule({
        match: 'any',
        conditions: [
          { field: 'from', value: 'nobody' },
          { field: 'subject', value: 'hello' },
        ],
      }),
    ])
    expect(any.test(input())).toBe(RULE_ID)
    expect(compileSplitRules([rule({ conditions: [] })]).test(input())).toBe('important')
    expect(any.needsRecipients).toBe(false)
    expect(
      compileSplitRules([rule({ conditions: [{ field: 'to', value: 'x' }] })]).needsRecipients,
    ).toBe(true)
  })

  it('picks the newest sender that is not the user', () => {
    const own = new Set(['zach@x.com'])
    expect(inboundSender(['zach@x.com', null, 'ana@x.com'], own, 'first@x.com')).toBe('ana@x.com')
    expect(inboundSender(['zach@x.com'], own, 'first@x.com')).toBe('first@x.com')
  })

  it('lists built-in tabs then custom splits', () => {
    expect(splitTabs([rule({ target: 'other', id: 'x' }), rule()]).map((t) => t.key)).toEqual([
      'important',
      'other',
      'newsletters',
      'notifications',
      RULE_ID,
    ])
  })

  it('validates untrusted rule bodies', () => {
    const body: Partial<SplitRuleRow> = rule()
    delete body.id
    expect(parseSplitRule(RULE_ID.toUpperCase(), { ...body, name: ' Stripe ' })).toEqual(rule())
    const bad =
      (b: unknown, id = RULE_ID) =>
      () =>
        parseSplitRule(id, b)
    expect(bad(body, 'x')).toThrow(InvalidSplitRuleError)
    expect(bad({ ...body, name: '' })).toThrow(InvalidSplitRuleError)
    expect(bad({ ...body, target: 'spam' })).toThrow(InvalidSplitRuleError)
    expect(bad({ ...body, match: 'some' })).toThrow(InvalidSplitRuleError)
    expect(bad({ ...body, position: 'x' })).toThrow(InvalidSplitRuleError)
    expect(bad({ ...body, conditions: [{ field: 'body', value: 'x' }] })).toThrow(
      InvalidSplitRuleError,
    )
  })
})

describe('flushSplitRules', () => {
  const outbox = (items: { id: string; rule: SplitRuleRow | null }[]) => {
    const log: string[] = []
    return {
      log,
      pending: () => items,
      ack: (p: { id: string }) => void log.push(`ack ${p.id}`),
      reject: (id: string) => void log.push(`reject ${id}`),
    }
  }
  const fail = (status: number) => Object.assign(new Error('x'), { status })

  it('acks, rejects 4xx and stops on transient errors', async () => {
    const o = outbox([
      { id: 'a', rule: rule({ id: 'a' }) },
      { id: 'b', rule: null },
      { id: 'c', rule: rule({ id: 'c' }) },
      { id: 'd', rule: null },
    ])
    const remote = {
      put: async (r: SplitRuleRow) => {
        if (r.id === 'c') throw fail(503)
      },
      delete: async () => {
        throw fail(400)
      },
    }
    await expect(flushSplitRules(o, remote)).rejects.toThrow()
    expect(o.log).toEqual(['ack a', 'reject b'])
  })
})
