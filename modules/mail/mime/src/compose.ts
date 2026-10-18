import { randomBytes } from 'node:crypto'
import type { Address } from './addresses'

export interface OutgoingAttachment {
  filename: string
  mime: string
  content: Uint8Array
  /** Referenced from the HTML as `cid:<contentId>`; such parts go in multipart/related. */
  contentId?: string
  inline?: boolean
}

export interface OutgoingMessage {
  from: Address
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  replyTo?: Address[]
  subject: string
  /** At least one of html/text; text is derived from html when missing. */
  html?: string
  text?: string
  /** Message-ID values like `<id@host>`. */
  inReplyTo?: string
  references?: string[]
  /** Generated as `<random@domain-of-from>` when absent. */
  messageId?: string
  date?: Date
  attachments?: OutgoingAttachment[]
  /** Extra headers; may not replace the ones buildMime writes itself. */
  headers?: Record<string, string>
}

export interface BuildMimeOptions {
  /**
   * Write the Bcc header. Off by default, which is right for SMTP (the envelope carries Bcc).
   * Gmail's send API reads recipients from the headers, so Gmail send passes `includeBcc: true`.
   */
  includeBcc?: boolean
}

interface Part {
  headers: [string, string][]
  body?: string
  boundary?: string
  children?: Part[]
}

const CRLF = '\r\n'
const MAX_LINE = 78
const ENCODED_WORD_BYTES = 36

const RESERVED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'reply-to',
  'subject',
  'date',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'content-disposition',
  'content-id',
])

/** Builds an RFC 5322 message with CRLF line endings, ready for SMTP or Gmail's `raw` field. */
export function buildMime(
  msg: OutgoingMessage,
  opts: BuildMimeOptions = {},
): { raw: Buffer; messageId: string } {
  const messageId = (msg.messageId && normalizeId(msg.messageId)) || generateMessageId(msg.from)
  const headers: [string, string][] = []
  const addresses = (name: string, list: Address[] | undefined) => {
    if (list?.length) headers.push([name, list.map(formatAddress).join(', ')])
  }

  headers.push(['From', formatAddress(msg.from)])
  addresses('To', msg.to)
  addresses('Cc', msg.cc)
  if (opts.includeBcc) addresses('Bcc', msg.bcc)
  addresses('Reply-To', msg.replyTo)
  headers.push(['Subject', encodeText(clean(msg.subject))])
  headers.push(['Date', formatDate(msg.date ?? new Date())])
  headers.push(['Message-ID', messageId])
  const inReplyTo = msg.inReplyTo && normalizeId(msg.inReplyTo)
  if (inReplyTo) headers.push(['In-Reply-To', inReplyTo])
  const references = (msg.references ?? []).map(normalizeId).filter((r) => r !== null)
  if (references.length) headers.push(['References', references.join(' ')])
  headers.push(['MIME-Version', '1.0'])

  for (const [name, value] of Object.entries(msg.headers ?? {})) {
    if (!/^[!-9;-~]+$/.test(name)) throw new Error(`Invalid header name: ${JSON.stringify(name)}`)
    if (RESERVED_HEADERS.has(name.toLowerCase()))
      throw new Error(`Header ${name} is set by buildMime`)
    headers.push([name, encodeText(clean(value))])
  }

  const root = bodyTree(msg)
  const head = [...headers, ...root.headers].map(([k, v]) => foldHeader(k, v)).join(CRLF)
  const raw = Buffer.from(head + CRLF + CRLF + renderBody(root) + CRLF, 'utf8')
  return { raw, messageId }
}

/** `Name <email>`, with an RFC 2047 encoded-word or quoted string for the name when needed. */
export function formatAddress(a: Address): string {
  const email = a.email.replace(/[\s<>]/g, '')
  const name = a.name ? clean(a.name).trim() : ''
  if (!name) return email
  return `${phrase(name)} <${email}>`
}

const REPLY_PREFIX = /^(re|aw|sv|antw|ref|odp)\s*(\[\d+\])?\s*:/i
const FORWARD_PREFIX = /^(fwd?|wg|tr|rv|enc)\s*(\[\d+\])?\s*:/i

export function replySubject(s: string): string {
  const subject = s.trim()
  return REPLY_PREFIX.test(subject) ? subject : `Re: ${subject}`
}

export function forwardSubject(s: string): string {
  const subject = s.trim()
  return FORWARD_PREFIX.test(subject) ? subject : `Fwd: ${subject}`
}

/** In-Reply-To and References for a reply to `parent` (RFC 5322 §3.6.4). */
export function replyReferences(parent: {
  rfc822MessageId: string | null
  references?: string[]
}): { inReplyTo?: string; references: string[] } {
  const refs: string[] = []
  for (const r of parent.references ?? []) {
    const id = normalizeId(r)
    if (id && !refs.includes(id)) refs.push(id)
  }
  const parentId = parent.rfc822MessageId ? normalizeId(parent.rfc822MessageId) : null
  if (!parentId) return { references: refs }
  if (!refs.includes(parentId)) refs.push(parentId)
  return { inReplyTo: parentId, references: refs }
}

/** HTML → readable plain text for the text/plain alternative. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n\n')
    .replace(/<\/(div|li|tr|h[1-6]|blockquote|ul|ol|table)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
  return decodeEntities(stripped)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Quoted-printable (RFC 2045 §6.7) of UTF-8 text; line breaks become CRLF, lines ≤ 76. */
export function encodeQuotedPrintable(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map(qpLine)
    .join(CRLF)
}

function qpLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8')
  const tokens: string[] = []
  bytes.forEach((b, i) => {
    const literal =
      (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && i < bytes.length - 1)
    tokens.push(
      literal ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0'),
    )
  })
  const out: string[] = []
  let cur = ''
  tokens.forEach((t, i) => {
    const room = i === tokens.length - 1 ? 76 : 75
    if (cur.length + t.length > room) {
      out.push(cur + '=')
      cur = ''
    }
    cur += t
  })
  out.push(cur)
  return out.join(CRLF)
}

function bodyTree(msg: OutgoingMessage): Part {
  const text = msg.text ? msg.text : msg.html ? htmlToText(msg.html) : ''
  let root = textPart('plain', text)
  if (msg.html) root = multipart('alternative', [root, textPart('html', msg.html)])

  const attachments = msg.attachments ?? []
  const related = msg.html ? attachments.filter((a) => a.contentId && a.inline !== false) : []
  const mixed = attachments.filter((a) => !related.includes(a))
  if (related.length) {
    root = multipart(
      'related',
      [root, ...related.map(attachmentPart)],
      ['type="multipart/alternative"'],
    )
  }
  if (mixed.length) root = multipart('mixed', [root, ...mixed.map(attachmentPart)])
  return root
}

function textPart(subtype: 'plain' | 'html', text: string): Part {
  return {
    headers: [
      ['Content-Type', `text/${subtype}; charset=utf-8`],
      ['Content-Transfer-Encoding', 'quoted-printable'],
    ],
    body: encodeQuotedPrintable(text),
  }
}

function multipart(subtype: string, children: Part[], params: string[] = []): Part {
  const boundary = `=_zm_${randomBytes(12).toString('hex')}`
  return {
    headers: [
      [
        'Content-Type',
        [`multipart/${subtype};`, ...params.map((p) => p + ';'), `boundary="${boundary}"`].join(
          ' ',
        ),
      ],
    ],
    boundary,
    children,
  }
}

function attachmentPart(a: OutgoingAttachment): Part {
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(a.mime)
    ? a.mime.toLowerCase()
    : 'application/octet-stream'
  const filename = clean(a.filename).trim() || 'attachment'
  const disposition = (a.inline ?? Boolean(a.contentId)) ? 'inline' : 'attachment'
  const headers: [string, string][] = [
    ['Content-Type', `${mime}; name=${quote(encodeText(filename))}`],
    ['Content-Transfer-Encoding', 'base64'],
    ['Content-Disposition', [disposition, ...filenameParams(filename)].join('; ')],
  ]
  const cid = a.contentId && normalizeId(a.contentId)
  if (cid) headers.push(['Content-ID', cid])
  const b64 = Buffer.from(a.content).toString('base64')
  return { headers, body: b64.match(/.{1,76}/g)?.join(CRLF) ?? '' }
}

/** RFC 2231 `filename*` (split into continuations when long) for non-ASCII names. */
function filenameParams(filename: string): string[] {
  if (!needsEncoding(filename)) return [`filename=${quote(filename)}`]
  const encoded = `UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`
  if (encoded.length <= 60) return [`filename*=${encoded}`]
  const segments = encoded.match(/(?:%[0-9A-F]{2}|[^%]){1,60}/g) ?? []
  return segments.map((s, i) => `filename*${i}*=${s}`)
}

function renderBody(p: Part): string {
  if (!p.children) return p.body ?? ''
  const b = p.boundary!
  const parts = p.children.map((c) => {
    const head = c.headers.map(([k, v]) => foldHeader(k, v)).join(CRLF)
    return `--${b}${CRLF}${head}${CRLF}${CRLF}${renderBody(c)}${CRLF}`
  })
  return parts.join('') + `--${b}--`
}

/** Folds at whitespace outside quoted strings so lines stay within 78 characters where possible. */
function foldHeader(name: string, value: string): string {
  const lines: string[] = []
  let line = `${name}:`
  let hasContent = false
  for (const word of splitWords(value)) {
    if (word && hasContent && line.length + 1 + word.length > MAX_LINE) {
      lines.push(line)
      line = ` ${word}`
    } else line += ` ${word}`
    if (word) hasContent = true
  }
  lines.push(line)
  return lines.join(CRLF)
}

function splitWords(value: string): string[] {
  const words: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '\\' && quoted) {
      cur += ch + (value[++i] ?? '')
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === ' ' && !quoted) {
      words.push(cur)
      cur = ''
    } else cur += ch
  }
  words.push(cur)
  return words
}

// Header values never carry raw CR/LF (header injection) or other control characters.
const clean = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const needsEncoding = (s: string) => /[^\t -~]/.test(s) || s.includes('=?')

const encodeText = (s: string) => (needsEncoding(s) ? encodeWords(s) : s)

function encodeWords(s: string): string {
  const words: string[] = []
  let chunk = ''
  for (const ch of s) {
    if (chunk && Buffer.byteLength(chunk + ch) > ENCODED_WORD_BYTES) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ')
}

const ATOM_PHRASE = /^[\w!#$%&'*+\-/=?^`{|}~]+( [\w!#$%&'*+\-/=?^`{|}~]+)*$/

function phrase(name: string): string {
  if (needsEncoding(name)) return encodeWords(name)
  return ATOM_PHRASE.test(name) ? name : quote(name)
}

const quote = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`

function normalizeId(id: string): string | null {
  const s = id.replace(/[\s<>]/g, '')
  return s ? `<${s}>` : null
}

function generateMessageId(from: Address): string {
  const domain = (from.email.split('@')[1] ?? '').replace(/[^\w.-]/g, '') || 'zachmail.local'
  return `<${randomBytes(16).toString('hex')}@${domain}>`
}

function formatDate(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid message date')
  return d.toUTCString().replace(/GMT$/, '+0000')
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  euro: '€',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
