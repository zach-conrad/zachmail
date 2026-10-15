import { describe, expect, it } from 'vitest'
import { instantIntro } from './intro'

const own = new Set(['zach@x.com'])
const intro = {
  from: { name: 'Pat Doe', email: 'pat@x.com' },
  to: [{ email: 'zach@x.com' }, { name: 'Ana', email: 'ana@y.com' }],
  cc: [{ email: 'ben@y.com' }],
  replyTo: [],
}

describe('instantIntro', () => {
  it('moves the introducer to Bcc and thanks them, once', () => {
    // A reply-all draft as the composer opens it.
    const draft = {
      to: [
        { name: 'Pat Doe', email: 'pat@x.com' },
        { name: 'Ana', email: 'ana@y.com' },
      ],
      cc: [{ email: 'ben@y.com' }],
      bcc: [],
      html: '<p>Great to meet you!</p>',
    }
    const out = instantIntro(draft, intro, own)!
    expect(out.to).toEqual([{ name: 'Ana', email: 'ana@y.com' }])
    expect(out.cc).toEqual([{ email: 'ben@y.com' }])
    expect(out.bcc).toEqual([{ name: 'Pat Doe', email: 'pat@x.com' }])
    expect(out.html).toBe(
      '<p data-zm-intro="">Thanks Pat (moved to Bcc)!</p><p>Great to meet you!</p>',
    )
    expect(instantIntro(out, intro, own)!.html).toBe(out.html)
  })

  it('fills To from the intro when replying only to the introducer', () => {
    const out = instantIntro({ to: [intro.from], cc: [], bcc: [], html: '' }, intro, own)!
    expect(out.to.map((a) => a.email)).toEqual(['ana@y.com', 'ben@y.com'])
  })

  it('declines when Zach made the intro or nobody is left', () => {
    expect(
      instantIntro(
        { to: [], cc: [], bcc: [], html: '' },
        { ...intro, from: { email: 'ZACH@x.com' } },
        own,
      ),
    ).toBeNull()
    expect(
      instantIntro(
        { to: [intro.from], cc: [], bcc: [], html: '' },
        { ...intro, to: [{ email: 'zach@x.com' }], cc: [] },
        own,
      ),
    ).toBeNull()
  })
})
