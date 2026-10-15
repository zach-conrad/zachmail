import { describe, expect, it } from 'vitest'
import {
  buildMime,
  encodeQuotedPrintable,
  formatAddress,
  forwardSubject,
  htmlToText,
  replyReferences,
  replySubject,
  type OutgoingMessage,
} from './index'

// --- a small test-only MIME parser, so assertions read our output the way a client would ---

interface Parsed {
  headers: Map<string, string[]>
  children?: Parsed[]
  content?: Buffer
}

const header = (p: Parsed, name: string) => p.headers.get(name.toLowerCase())?.[0]

function decodeWords(s: string): string {
  return s
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_m, b64: string) =>
      Buffer.from(b64, 'base64').toString('utf8'),
    )
}

function decodeQuotedPrintable(s: string): Buffer {
  const bytes: number[] = []
  const src = s.replace(/=\r\n/g, '')
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=') {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(src.charCodeAt(i))
  }
  return Buffer.from(bytes)
}

function param(value: string | undefined, key: string): string | undefined {
  if (!value) return undefined
  const m = value.match(new RegExp(`;\\s*${key}="((?:[^"\\\\]|\\\\.)*)"`, 'i'))
  if (m) return m[1]!.replace(/\\(.)/g, '$1')
  const ext = [...value.matchAll(new RegExp(`;\\s*${key}\\*(?:(\\d+)\\*)?=([^;\\s]+)`, 'gi'))]
  if (!ext.length) return value.match(new RegExp(`;\\s*${key}=([^;\\s]+)`, 'i'))?.[1]
  const joined = ext
    .sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0))
    .map((x) => x[2])
    .join('')
  return decodeURIComponent(joined.replace(/^UTF-8''/i, ''))
}

function parse(raw: string): Parsed {
  const split = raw.indexOf('\r\n\r\n')
  const head = split === -1 ? raw : raw.slice(0, split)
  const body = split === -1 ? '' : raw.slice(split + 4)
  const headers = new Map<string, string[]>()
  for (const line of head.replace(/\r\n(?=[ \t])/g, '').split('\r\n')) {
    const i = line.indexOf(':')
    const name = line.slice(0, i).toLowerCase()
    headers.set(name, [...(headers.get(name) ?? []), line.slice(i + 1).trim()])
  }
  const part: Parsed = { headers }
  const type = header(part, 'content-type') ?? 'text/plain'
  if (/^multipart\//i.test(type)) {
    const boundary = param(type, 'boundary')!
    const end = body.indexOf(`\r\n--${boundary}--`)
    expect(end).toBeGreaterThan(-1)
    const sections = body.slice(0, end).split(`--${boundary}\r\n`)
    expect(sections[0]).toBe('')
    part.children = sections.slice(1).map((s) => parse(s.replace(/\r\n$/, '')))
    return part
  }
  const cte = header(part, 'content-transfer-encoding')?.toLowerCase()
  part.content =
    cte === 'base64'
      ? Buffer.from(body.replace(/\r\n/g, ''), 'base64')
      : cte === 'quoted-printable'
        ? decodeQuotedPrintable(body)
        : Buffer.from(body)
  return part
}

const shape = (p: Parsed): unknown =>
  p.children
    ? { [header(p, 'content-type')!.split(';')[0]!]: p.children.map(shape) }
    : header(p, 'content-type')!.split(';')[0]

const text = (p: Parsed) => p.content!.toString('utf8')

const lines = (raw: string) => raw.split('\r\n')

function expectWellFormed(raw: Buffer) {
  const s = raw.toString('utf8')
  expect(s).not.toMatch(/[^\r]\n|\r(?!\n)/)
  expect(s.endsWith('\r\n')).toBe(true)
  for (const l of lines(s)) expect(l.length).toBeLessThanOrEqual(998)
  // eslint-disable-next-line no-control-regex
  expect(s).not.toMatch(/[^\x00-\x7f]/)
}

const base: OutgoingMessage = {
  from: { name: 'Zach Conrad', email: 'zach@example.com' },
  to: [{ email: 'ana@x.com' }],
  subject: 'Hello',
  date: new Date('2026-10-14T09:05:03Z'),
}

const png = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 256))
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])

function build(msg: Partial<OutgoingMessage>, opts?: { includeBcc?: boolean }) {
  const out = buildMime({ ...base, ...msg }, opts)
  expectWellFormed(out.raw)
  return {
    ...out,
    str: out.raw.toString('utf8'),
    parsed: parse(out.raw.toString('utf8').replace(/\r\n$/, '')),
  }
}

describe('buildMime structure', () => {
  it('text only is a single quoted-printable text/plain part', () => {
    const { parsed } = build({ text: 'Hi Ana,\nsee you soon.' })
    expect(shape(parsed)).toBe('text/plain')
    expect(header(parsed, 'content-type')).toBe('text/plain; charset=utf-8')
    expect(header(parsed, 'content-transfer-encoding')).toBe('quoted-printable')
    expect(header(parsed, 'mime-version')).toBe('1.0')
    expect(text(parsed)).toBe('Hi Ana,\r\nsee you soon.')
  })

  it('html only becomes multipart/alternative with derived text', () => {
    const { parsed } = build({ html: '<p>Hi <b>Ana</b> &amp; co</p><p>Line<br>two</p>' })
    expect(shape(parsed)).toEqual({ 'multipart/alternative': ['text/plain', 'text/html'] })
    const [plain, html] = parsed.children!
    expect(text(plain!)).toBe('Hi Ana & co\r\n\r\nLine\r\ntwo')
    expect(text(html!)).toBe('<p>Hi <b>Ana</b> &amp; co</p><p>Line<br>two</p>')
  })

  it('keeps explicit text alongside html', () => {
    const { parsed } = build({ html: '<p>rich</p>', text: 'plain' })
    expect(text(parsed.children![0]!)).toBe('plain')
  })

  it('wraps alternative in multipart/related for inline images', () => {
    const { parsed } = build({
      html: '<img src="cid:logo@zm">',
      attachments: [
        { filename: 'logo.png', mime: 'image/png', content: png, contentId: 'logo@zm' },
      ],
    })
    expect(shape(parsed)).toEqual({
      'multipart/related': [{ 'multipart/alternative': ['text/plain', 'text/html'] }, 'image/png'],
    })
    expect(param(header(parsed, 'content-type'), 'type')).toBe('multipart/alternative')
    const img = parsed.children![1]!
    expect(header(img, 'content-id')).toBe('<logo@zm>')
    expect(header(img, 'content-disposition')).toBe('inline; filename="logo.png"')
    expect(Buffer.compare(img.content!, Buffer.from(png))).toBe(0)
  })

  it('wraps in multipart/mixed for regular attachments', () => {
    const { parsed } = build({
      html: '<p>see attached</p>',
      attachments: [{ filename: 'report.pdf', mime: 'application/pdf', content: pdf }],
    })
    expect(shape(parsed)).toEqual({
      'multipart/mixed': [
        { 'multipart/alternative': ['text/plain', 'text/html'] },
        'application/pdf',
      ],
    })
    const att = parsed.children![1]!
    expect(header(att, 'content-disposition')).toBe('attachment; filename="report.pdf"')
    expect(param(header(att, 'content-type'), 'name')).toBe('report.pdf')
    expect(Buffer.compare(att.content!, Buffer.from(pdf))).toBe(0)
  })

  it('nests mixed > related > alternative when both kinds are present', () => {
    const { parsed } = build({
      html: '<img src="cid:a@zm">',
      attachments: [
        { filename: 'a.png', mime: 'image/png', content: png, contentId: 'a@zm' },
        { filename: 'r.pdf', mime: 'application/pdf', content: pdf },
      ],
    })
    expect(shape(parsed)).toEqual({
      'multipart/mixed': [
        {
          'multipart/related': [
            { 'multipart/alternative': ['text/plain', 'text/html'] },
            'image/png',
          ],
        },
        'application/pdf',
      ],
    })
  })

  it('text with attachment is mixed > text/plain; cid parts without html go in mixed', () => {
    const { parsed } = build({
      text: 'hi',
      attachments: [
        { filename: 'r.pdf', mime: 'application/pdf', content: pdf },
        { filename: 'a.png', mime: 'image/png', content: png, contentId: 'a@zm' },
      ],
    })
    expect(shape(parsed)).toEqual({
      'multipart/mixed': ['text/plain', 'application/pdf', 'image/png'],
    })
  })

  it('inline: false keeps a cid attachment out of related', () => {
    const { parsed } = build({
      html: '<p>x</p>',
      attachments: [
        { filename: 'a.png', mime: 'image/png', content: png, contentId: 'a@zm', inline: false },
      ],
    })
    expect(shape(parsed)).toEqual({
      'multipart/mixed': [{ 'multipart/alternative': ['text/plain', 'text/html'] }, 'image/png'],
    })
    expect(header(parsed.children![1]!, 'content-disposition')).toMatch(/^attachment;/)
  })

  it('wraps base64 at 76 columns', () => {
    const big = new Uint8Array(5000).map((_, i) => i % 251)
    const { str, parsed } = build({
      text: 'x',
      attachments: [{ filename: 'b.bin', mime: 'application/octet-stream', content: big }],
    })
    const b64Lines = lines(str).filter((l) => /^[A-Za-z0-9+/]{20,}={0,2}$/.test(l))
    expect(b64Lines.length).toBeGreaterThan(50)
    for (const l of b64Lines.slice(0, -1)) expect(l.length).toBe(76)
    expect(Buffer.compare(parsed.children![1]!.content!, Buffer.from(big))).toBe(0)
  })

  it('falls back to application/octet-stream for a bogus mime type', () => {
    const { parsed } = build({
      text: 'x',
      attachments: [{ filename: 'x', mime: 'text/html\r\nX-Evil: 1', content: pdf }],
    })
    expect(shape(parsed)).toEqual({ 'multipart/mixed': ['text/plain', 'application/octet-stream'] })
  })

  it('uses fresh random boundaries', () => {
    const a = build({ html: '<p>x</p>' }).parsed
    const b = build({ html: '<p>x</p>' }).parsed
    const ba = param(header(a, 'content-type'), 'boundary')!
    expect(ba).toMatch(/^=_zm_[0-9a-f]{24}$/)
    expect(ba).not.toBe(param(header(b, 'content-type'), 'boundary'))
  })
})

describe('buildMime headers', () => {
  it('writes the standard headers in order', () => {
    const { str, messageId } = build({
      cc: [{ name: 'Lee, J', email: 'j@z.io' }],
      replyTo: [{ email: 'reply@example.com' }],
      inReplyTo: '<p1@x>',
      references: ['<p0@x>', 'p1@x'],
      text: 'x',
    })
    const head = str.slice(0, str.indexOf('\r\n\r\n'))
    expect(head.replace(/\r\n /g, ' ')).toBe(
      [
        'From: Zach Conrad <zach@example.com>',
        'To: ana@x.com',
        'Cc: "Lee, J" <j@z.io>',
        'Reply-To: reply@example.com',
        'Subject: Hello',
        'Date: Wed, 14 Oct 2026 09:05:03 +0000',
        `Message-ID: ${messageId}`,
        'In-Reply-To: <p1@x>',
        'References: <p0@x> <p1@x>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: quoted-printable',
      ].join('\r\n'),
    )
  })

  it('generates a Message-ID on the sender domain, or normalizes the given one', () => {
    expect(build({ text: 'x' }).messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/)
    const { messageId, parsed } = build({ text: 'x', messageId: 'abc@host' })
    expect(messageId).toBe('<abc@host>')
    expect(header(parsed, 'message-id')).toBe('<abc@host>')
  })

  it('omits Bcc unless includeBcc', () => {
    const bcc = [{ name: 'Secret', email: 's@x.com' }]
    expect(build({ text: 'x', bcc }).parsed.headers.has('bcc')).toBe(false)
    expect(header(build({ text: 'x', bcc }, { includeBcc: true }).parsed, 'bcc')).toBe(
      'Secret <s@x.com>',
    )
  })

  it('encodes non-ASCII subjects as RFC 2047 words and folds them', () => {
    const subject = 'Café meeting — résumé attached 🎉 '.repeat(4).trim()
    const { str, parsed } = build({ subject, text: 'x' })
    const raw = header(parsed, 'subject')!
    expect(raw).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(raw)).toBe(subject)
    const head = lines(str.slice(0, str.indexOf('\r\n\r\n')))
    for (const l of head) expect(l.length).toBeLessThanOrEqual(78)
    for (const w of raw.split(' ')) expect(w.length).toBeLessThanOrEqual(75)
  })

  it('folds long ASCII subjects at whitespace and leaves them readable', () => {
    const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const { str, parsed } = build({ subject, text: 'x' })
    expect(header(parsed, 'subject')).toBe(subject)
    expect(str).toMatch(/\r\nSubject: word0[^\r]*\r\n word/)
  })

  it('encodes ASCII text that looks like an encoded word', () => {
    const { parsed } = build({ subject: 'about =?UTF-8?B?x?= syntax', text: 'x' })
    expect(header(parsed, 'subject')).toMatch(/^=\?UTF-8\?B\?/)
    expect(decodeWords(header(parsed, 'subject')!)).toBe('about =?UTF-8?B?x?= syntax')
  })

  it('encodes non-ASCII display names and extra header values', () => {
    const { parsed } = build({
      to: [{ name: 'José Ñúñez', email: 'jose@x.es' }],
      headers: { 'X-Note': 'naïve' },
      text: 'x',
    })
    expect(decodeWords(header(parsed, 'to')!)).toBe('José Ñúñez <jose@x.es>')
    expect(decodeWords(header(parsed, 'x-note')!)).toBe('naïve')
  })

  it('writes RFC 2231 filename* for non-ASCII filenames, with continuations when long', () => {
    const { parsed } = build({
      text: 'x',
      attachments: [
        { filename: 'résumé (final).pdf', mime: 'application/pdf', content: pdf },
        { filename: `${'отчёт-'.repeat(12)}.pdf`, mime: 'application/pdf', content: pdf },
      ],
    })
    const [, short, long] = parsed.children!
    const d1 = header(short!, 'content-disposition')!
    expect(d1).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28final%29.pdf")
    expect(param(d1, 'filename')).toBe('résumé (final).pdf')
    expect(decodeWords(param(header(short!, 'content-type'), 'name')!)).toBe('résumé (final).pdf')
    const d2 = header(long!, 'content-disposition')!
    expect(d2).toMatch(/filename\*0\*=UTF-8''/)
    expect(d2).toMatch(/filename\*1\*=/)
    expect(param(d2, 'filename')).toBe(`${'отчёт-'.repeat(12)}.pdf`)
  })

  it('escapes quotes in ASCII filenames', () => {
    const { parsed } = build({
      text: 'x',
      attachments: [{ filename: 'say "hi".txt', mime: 'text/plain', content: pdf }],
    })
    const d = header(parsed.children![1]!, 'content-disposition')!
    expect(d).toBe('attachment; filename="say \\"hi\\".txt"')
    expect(param(d, 'filename')).toBe('say "hi".txt')
  })
})

describe('header injection', () => {
  it('strips CR/LF from subject, names, addresses and ids', () => {
    const { str, parsed } = build({
      subject: 'Hi\r\nBcc: victim@x.com',
      from: { name: 'Zach\r\nX-Evil: 1', email: 'zach@example.com\r\nX-Evil: 2' },
      to: [{ name: 'Ana\nBcc: v@x.com', email: 'ana@x.com' }],
      inReplyTo: '<a@b>\r\nX-Evil: 3',
      references: ['<r@b>\nX-Evil: 4'],
      text: 'x',
    })
    const head = str.slice(0, str.indexOf('\r\n\r\n'))
    expect(head).not.toMatch(/\r\n(Bcc|X-Evil):/i)
    expect(parsed.headers.has('bcc')).toBe(false)
    expect(parsed.headers.has('x-evil')).toBe(false)
    expect(header(parsed, 'subject')).toBe('Hi Bcc: victim@x.com')
  })

  it('strips CR/LF from extra header values and filenames', () => {
    const { parsed } = build({
      headers: { 'X-Mailer': 'zm\r\nBcc: v@x.com' },
      text: 'x',
      attachments: [
        { filename: 'a.txt\r\nContent-Type: text/html', mime: 'text/plain', content: pdf },
      ],
    })
    expect(header(parsed, 'x-mailer')).toBe('zm Bcc: v@x.com')
    expect(parsed.headers.has('bcc')).toBe(false)
    expect(parsed.children![1]!.headers.get('content-type')).toHaveLength(1)
  })

  it('rejects invalid or reserved extra header names', () => {
    expect(() => buildMime({ ...base, text: 'x', headers: { 'X-A\r\nBcc': 'v' } })).toThrow()
    expect(() => buildMime({ ...base, text: 'x', headers: { 'Bad Name': 'v' } })).toThrow()
    expect(() => buildMime({ ...base, text: 'x', headers: { bcc: 'v@x.com' } })).toThrow()
    expect(() =>
      buildMime({ ...base, text: 'x', headers: { 'content-type': 'text/html' } }),
    ).toThrow()
  })

  it('keeps a body that looks like headers inside the body', () => {
    const { parsed } = build({ text: '\r\n\r\nBcc: v@x.com\r\n--fake--' })
    expect(parsed.headers.has('bcc')).toBe(false)
    expect(text(parsed)).toBe('\r\n\r\nBcc: v@x.com\r\n--fake--')
  })
})

describe('quoted-printable', () => {
  const roundTrip = (s: string) => {
    const enc = encodeQuotedPrintable(s)
    for (const l of lines(enc)) {
      expect(l.length).toBeLessThanOrEqual(76)
      expect(l).not.toMatch(/[ \t]$/)
      expect(l).toMatch(/^[\t -~]*$/)
    }
    expect(decodeQuotedPrintable(enc).toString('utf8')).toBe(s.replace(/\r\n|\r|\n/g, '\r\n'))
    return enc
  }

  it('round-trips long ASCII lines with soft breaks', () => {
    const enc = roundTrip('a'.repeat(200))
    expect(lines(enc)).toEqual(['a'.repeat(75) + '=', 'a'.repeat(75) + '=', 'a'.repeat(50)])
  })

  it('allows a full 76-character final line', () => {
    expect(encodeQuotedPrintable('a'.repeat(76))).toBe('a'.repeat(76))
    expect(encodeQuotedPrintable('a'.repeat(77))).toBe(`${'a'.repeat(75)}=\r\naa`)
  })

  it('never splits an escape sequence across a soft break', () => {
    for (let n = 70; n < 80; n++) {
      const enc = roundTrip('a'.repeat(n) + '=é='.repeat(10))
      for (const l of lines(enc)) expect(l).not.toMatch(/=[0-9A-F]?=$/)
    }
  })

  it('round-trips long UTF-8 lines', () => {
    roundTrip('Ünïcødé — 日本語のテキスト 🎉 '.repeat(20))
    roundTrip('ä'.repeat(100))
  })

  it('encodes =, trailing whitespace and control bytes', () => {
    expect(encodeQuotedPrintable('a=b')).toBe('a=3Db')
    expect(encodeQuotedPrintable('end \nnext\t')).toBe('end=20\r\nnext=09')
    expect(encodeQuotedPrintable('é')).toBe('=C3=A9')
    roundTrip('tabs\tand  spaces  \r\n  \r\n')
  })

  it('round-trips random text', () => {
    const alphabet = 'ab =\t.é€😀\n\r-'
    for (let k = 0; k < 200; k++) {
      let s = ''
      const len = (k * 7919) % 400
      for (let i = 0; i < len; i++) s += [...alphabet][(i * 31 + k * 17) % [...alphabet].length]
      roundTrip(s)
    }
  })
})

describe('formatAddress', () => {
  it('formats bare, atom, quoted and encoded names', () => {
    expect(formatAddress({ email: 'a@x.com' })).toBe('a@x.com')
    expect(formatAddress({ name: '', email: 'a@x.com' })).toBe('a@x.com')
    expect(formatAddress({ name: 'Ana Ruiz', email: 'a@x.com' })).toBe('Ana Ruiz <a@x.com>')
    expect(formatAddress({ name: 'Ruiz, Ana', email: 'a@x.com' })).toBe('"Ruiz, Ana" <a@x.com>')
    expect(formatAddress({ name: 'A. "Bo" \\ C', email: 'a@x.com' })).toBe(
      '"A. \\"Bo\\" \\\\ C" <a@x.com>',
    )
    const enc = formatAddress({ name: 'Zoë', email: 'z@x.com' })
    expect(enc).toBe('=?UTF-8?B?Wm/Dqw==?= <z@x.com>')
  })
})

describe('reply helpers', () => {
  it('replySubject adds Re: once', () => {
    expect(replySubject('Lunch')).toBe('Re: Lunch')
    expect(replySubject('Re: Lunch')).toBe('Re: Lunch')
    expect(replySubject('RE: Lunch')).toBe('RE: Lunch')
    expect(replySubject('AW: Mittag')).toBe('AW: Mittag')
    expect(replySubject('Sv: Lunsj')).toBe('Sv: Lunsj')
    expect(replySubject('Re[2]: Lunch')).toBe('Re[2]: Lunch')
    expect(replySubject('Fwd: Lunch')).toBe('Re: Fwd: Lunch')
    expect(replySubject('Regarding lunch')).toBe('Re: Regarding lunch')
    expect(replySubject('')).toBe('Re: ')
  })

  it('forwardSubject adds Fwd: once', () => {
    expect(forwardSubject('Lunch')).toBe('Fwd: Lunch')
    expect(forwardSubject('Fwd: Lunch')).toBe('Fwd: Lunch')
    expect(forwardSubject('FW: Lunch')).toBe('FW: Lunch')
    expect(forwardSubject('WG: Mittag')).toBe('WG: Mittag')
    expect(forwardSubject('Re: Lunch')).toBe('Fwd: Re: Lunch')
  })

  it('replyReferences chains the parent id onto its references', () => {
    expect(
      replyReferences({ rfc822MessageId: '<p2@x>', references: ['<p0@x>', 'p1@x', '<p0@x>'] }),
    ).toEqual({ inReplyTo: '<p2@x>', references: ['<p0@x>', '<p1@x>', '<p2@x>'] })
    expect(replyReferences({ rfc822MessageId: 'p@x' })).toEqual({
      inReplyTo: '<p@x>',
      references: ['<p@x>'],
    })
    expect(replyReferences({ rfc822MessageId: null, references: ['<a@x>'] })).toEqual({
      references: ['<a@x>'],
    })
  })

  it('feeds straight into buildMime', () => {
    const { parsed } = build({
      ...replyReferences({ rfc822MessageId: '<p@x>', references: ['<o@x>'] }),
      subject: replySubject('Plans'),
      text: 'ok',
    })
    expect(header(parsed, 'in-reply-to')).toBe('<p@x>')
    expect(header(parsed, 'references')).toBe('<o@x> <p@x>')
    expect(header(parsed, 'subject')).toBe('Re: Plans')
  })
})

describe('htmlToText', () => {
  it('strips tags, decodes entities and maps blocks to newlines', () => {
    expect(
      htmlToText(
        '<html><head><style>p{}</style></head><body><p>Hello&nbsp;<b>there</b>,</p>\n<p>a &lt;tag&gt; &#233; &#x1F600;</p><div>one</div><div>two<br/>three</div><ul><li>x</li><li>y</li></ul></body></html>',
      ),
    ).toBe('Hello there,\n\na <tag> é 😀\n\none\ntwo\nthree\n- x\n- y')
  })
})
