import { describe, expect, it } from 'vitest'
import {
  InvalidSnippetError,
  expandSnippet,
  findSnippetTrigger,
  matchSnippets,
  mergeAddresses,
  parseSnippetInput,
  snippetForShortcut,
  splitName,
  type SnippetRow,
} from './snippets'

const row = (over: Partial<SnippetRow>): SnippetRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Intro call',
  shortcut: 'call',
  subject: '',
  html: '',
  cc: [],
  bcc: [],
  updatedAt: 0,
  ...over,
})

describe('parseSnippetInput', () => {
  it('normalises and validates', () => {
    expect(parseSnippetInput({ name: ' Call ', shortcut: 'CALL', html: '<p>x</p>' })).toEqual({
      name: 'Call',
      shortcut: 'call',
      subject: '',
      html: '<p>x</p>',
      cc: [],
      bcc: [],
    })
    expect(() => parseSnippetInput({ name: '', html: '' })).toThrow(InvalidSnippetError)
    expect(() => parseSnippetInput({ name: 'a', shortcut: 'two words', html: '' })).toThrow(
      /shortcut/,
    )
    expect(() => parseSnippetInput({ name: 'a', html: '', cc: [{ email: 'nope' }] })).toThrow(
      /cc\[0\]/,
    )
  })
})

describe('splitName', () => {
  it('handles display names, "Last, First" and bare addresses', () => {
    expect(splitName({ name: 'Ana Lopez', email: 'a@x.com' })).toMatchObject({
      first: 'Ana',
      last: 'Lopez',
    })
    expect(splitName({ name: '"Lopez, Ana"', email: 'a@x.com' }).first).toBe('Ana')
    expect(splitName({ email: 'ana.lopez@x.com' })).toMatchObject({ first: 'Ana', last: 'Lopez' })
    expect(splitName({ email: 'x9_42@x.com' }).first).toBe('')
  })
})

describe('expandSnippet', () => {
  const s = row({
    subject: 'Call with {first_name}',
    html: '<p>Hi {First_Name|there}, {last_name}. {nope} — {my_first_name} on {day}</p>',
    bcc: [{ email: 'crm@x.com' }],
  })
  const now = new Date('2026-10-14T12:00:00Z')

  it('fills variables, escapes html and keeps unknown ones', () => {
    const out = expandSnippet(s, {
      to: [
        { name: 'Ana <Lopez>', email: 'ana@x.com' },
        { name: 'Ben Ng', email: 'ben@x.com' },
      ],
      from: { name: 'Zach Conrad', email: 'z@x.com' },
      now,
      locale: 'en-US',
    })
    expect(out.subject).toBe('Call with Ana and Ben')
    expect(out.html).toBe('<p>Hi Ana and Ben, &lt;Lopez&gt; and Ng. {nope} — Zach on Wednesday</p>')
    expect(out.bcc).toEqual([{ email: 'crm@x.com' }])
    expect(out.missing).toEqual([])
  })

  it('uses fallbacks and reports what is missing', () => {
    const out = expandSnippet(s, { to: [], now })
    expect(out.html).toContain('Hi there, .')
    expect(out.missing.sort()).toEqual(['first_name', 'last_name', 'my_first_name'])
    expect(out.subject).toBe('Call with ')
  })
})

describe('triggers and matching', () => {
  const list = [
    row({ id: '1', name: 'Intro call', shortcut: 'call' }),
    row({ id: '2', name: 'Calendar link', shortcut: 'cal' }),
    row({ id: '3', name: 'Thanks, will review', shortcut: '' }),
  ]

  it('finds ;query only at a word start', () => {
    expect(findSnippetTrigger('Hi ;ca')).toEqual({ query: 'ca', start: 3 })
    expect(findSnippetTrigger(';')).toEqual({ query: '', start: 0 })
    expect(findSnippetTrigger('a;b')).toBeNull()
    expect(findSnippetTrigger('Hi ;ca ')).toBeNull()
  })

  it('ranks exact shortcut, then prefix, then name words, then fuzzy', () => {
    expect(matchSnippets('cal', list).map((s) => s.id)).toEqual(['2', '1'])
    expect(matchSnippets('review', list).map((s) => s.id)).toEqual(['3'])
    expect(matchSnippets('tnks', list).map((s) => s.id)).toEqual(['3'])
    expect(matchSnippets('', list).map((s) => s.id)).toEqual(['2', '1', '3'])
    expect(snippetForShortcut('CALL', list)?.id).toBe('1')
    expect(snippetForShortcut('', list)).toBeUndefined()
  })
})

describe('mergeAddresses', () => {
  it('adds only new addresses', () => {
    expect(
      mergeAddresses(
        [{ email: 'A@x.com' }],
        [{ email: 'a@x.com' }, { email: 'b@x.com' }],
        [{ email: 'b@X.com' }],
      ),
    ).toEqual([{ email: 'A@x.com' }])
  })
})
