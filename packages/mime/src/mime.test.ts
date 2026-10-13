import { describe, expect, it } from 'vitest'
import { parseAddressList, sanitizeEmailHtml, textToHtml } from './index'

const proxy = (u: string) => `/api/img?u=${encodeURIComponent(u)}`

describe('sanitizeEmailHtml', () => {
  it('removes scripts, handlers and javascript: links', () => {
    const { html } = sanitizeEmailHtml(
      '<p onclick="x()">hi<script>alert(1)</script></p><a href="javascript:alert(1)">x</a><iframe src="https://e.vil"></iframe>',
      { proxyImage: proxy },
    )
    expect(html).not.toMatch(/script|onclick|javascript:|iframe/i)
    expect(html).toContain('<p>hi</p>')
  })

  it('parks remote images behind the proxy and reports them', () => {
    const r = sanitizeEmailHtml('<img src="https://t.co/pixel.gif" width="1">', { proxyImage: proxy })
    expect(r.hasRemoteImages).toBe(true)
    expect(r.html).not.toMatch(/\ssrc=/)
    expect(r.html).toContain('data-zm-src="/api/img?u=https%3A%2F%2Ft.co%2Fpixel.gif"')
  })

  it('keeps inline data images and cid references', () => {
    const r = sanitizeEmailHtml('<img src="data:image/png;base64,AAA"><img src="cid:logo@x">', {
      proxyImage: proxy,
    })
    expect(r.hasRemoteImages).toBe(false)
    expect(r.html).toContain('src="data:image/png;base64,AAA"')
    expect(r.html).toContain('data-zm-cid="logo@x"')
  })

  it('defuses remote loads in CSS', () => {
    const { html } = sanitizeEmailHtml(
      '<style>@import url(https://x/a.css); .a{background:url(https://x/b.png)}</style><div style="background-image:url(https://x/c.png)">x</div>',
      { proxyImage: proxy },
    )
    expect(html).not.toMatch(/https:\/\/x\//)
    expect(html).toContain('<style>')
  })

  it('opens links in a new context without referrer', () => {
    const { html } = sanitizeEmailHtml('<a href="https://ok.com">ok</a>', { proxyImage: proxy })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })
})

describe('textToHtml', () => {
  it('escapes and links', () => {
    expect(textToHtml('<b> see https://x.com/a?b=1')).toBe(
      '<div style="white-space: pre-wrap">&lt;b&gt; see <a href="https://x.com/a?b=1" target="_blank" rel="noopener noreferrer">https://x.com/a?b=1</a></div>',
    )
  })
})

describe('parseAddressList', () => {
  it('handles names, quotes with commas and bare addresses', () => {
    expect(parseAddressList('Ana Ruiz <Ana@X.com>, "Lee, J" <j@z.io>, bob@y.com')).toEqual([
      { name: 'Ana Ruiz', email: 'ana@x.com' },
      { name: 'Lee, J', email: 'j@z.io' },
      { email: 'bob@y.com' },
    ])
  })
  it('never throws on junk', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([])
    expect(parseAddressList(undefined)).toEqual([])
  })
})
