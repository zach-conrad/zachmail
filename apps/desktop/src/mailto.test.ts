import { describe, expect, it } from 'vitest'
import { parseMailto } from './mailto'

describe('parseMailto', () => {
  it('parses a bare address', () => {
    expect(parseMailto('mailto:zach@example.com')).toEqual({
      to: ['zach@example.com'],
      cc: [],
      bcc: [],
      subject: '',
      body: '',
    })
  })

  it('parses headers, multiple recipients and encoded text', () => {
    const d = parseMailto(
      'mailto:a@x.com,b@x.com?cc=c@x.com&BCC=d@x.com&to=e@x.com&subject=Hi%20there%2B1&body=Line%201%0D%0ALine+2',
    )
    expect(d).toEqual({
      to: ['a@x.com', 'b@x.com', 'e@x.com'],
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      subject: 'Hi there+1',
      body: 'Line 1\nLine+2',
    })
  })

  it('handles an empty address and malformed escapes', () => {
    expect(parseMailto('mailto:?subject=%E0%A4%A')?.subject).toBe('%E0%A4%A')
    expect(parseMailto('mailto:?subject=x')?.to).toEqual([])
  })

  it('rejects other schemes', () => {
    expect(parseMailto('https://example.com')).toBeNull()
  })
})
