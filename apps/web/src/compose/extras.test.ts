import type { MessageRow, SnippetRow } from '@zachmail/core'
import { describe, expect, it } from 'vitest'
import type { Draft } from './draft'
import { applyIntro, applySnippet, htmlToText } from './extras'

const draft = (over: Partial<Draft> = {}): Draft => ({
  id: 'd',
  kind: 'new',
  accountId: 'a',
  to: [{ name: 'Ana Lopez', email: 'ana@a.com' }],
  cc: [],
  bcc: [],
  subject: '',
  text: '',
  ...over,
})

const snippet: SnippetRow = {
  id: 's',
  name: 'Call',
  shortcut: 'call',
  subject: 'Call with {first_name}',
  html: '<p>Hi {first_name},</p><p>Free Tue?<br>— {my_first_name}</p>',
  cc: [],
  bcc: [{ email: 'crm@z.com' }],
  updatedAt: 0,
}

describe('htmlToText', () => {
  it('keeps paragraphs and line breaks and decodes entities', () => {
    expect(htmlToText('<p>A &amp; B</p><p>x<br/>y &#39;z&#x27;</p>')).toBe("A & B\n\nx\ny 'z'")
  })
})

describe('applySnippet', () => {
  it('replaces the typed trigger and fills subject and bcc', () => {
    const d = draft({ text: 'Hey ;ca and more' })
    const r = applySnippet(d, snippet, 4, 7, { name: 'Zach Conrad', email: 'z@z.com' })
    expect(r.patch.text).toBe('Hey Hi Ana,\n\nFree Tue?\n— Zach and more')
    expect(r.caret).toBe('Hey Hi Ana,\n\nFree Tue?\n— Zach'.length)
    expect(r.patch.subject).toBe('Call with Ana')
    expect(r.patch.bcc).toEqual([{ email: 'crm@z.com' }])
    expect(r.missing).toEqual([])
  })

  it('leaves a typed subject alone and reports missing names', () => {
    const r = applySnippet(draft({ to: [], subject: 'Mine' }), snippet, 0, 0)
    expect(r.patch.subject).toBeUndefined()
    expect(r.missing.sort()).toEqual(['first_name', 'my_first_name'])
  })
})

describe('applyIntro', () => {
  const intro = {
    from: { name: 'Pat Doe', email: 'pat@p.com' },
    to: [{ email: 'zach@z.com' }, { email: 'ana@a.com' }],
    cc: [],
    replyTo: [],
  } as unknown as MessageRow

  it('moves the introducer to Bcc and thanks them once', () => {
    const d = draft({ kind: 'replyAll', to: [intro.from!, { email: 'ana@a.com' }], text: 'Hi!' })
    const p = applyIntro(d, intro, new Set(['zach@z.com']))!
    expect(p.to).toEqual([{ email: 'ana@a.com' }])
    expect(p.bcc).toEqual([intro.from])
    expect(p.text).toBe('Thanks Pat (moved to Bcc)!\n\nHi!')
    expect(applyIntro({ ...d, ...p }, intro, new Set(['zach@z.com']))!.text).toBe(p.text)
  })
})
