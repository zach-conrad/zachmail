import { parseAddress, parseAddressList } from '@zachmail/mime'
import type {
  FolderKind,
  ProviderAttachment,
  ProviderFolder,
  ProviderMessage,
  RawBody,
} from '../types'
import { decodeBase64Url, decodeText } from '../util'
import type { GmailLabel, GmailMessage, GmailPart } from './types'

/** Headers requested with format=metadata: everything the list and threading need. */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Bcc',
  'Reply-To',
  'Subject',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
  'List-Unsubscribe',
]

const SYSTEM_KINDS: Record<string, FolderKind> = {
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFT: 'drafts',
  TRASH: 'trash',
  SPAM: 'spam',
  STARRED: 'starred',
  IMPORTANT: 'important',
}

// Labels that are flags or Gmail-internal groupings, not folders Zach navigates to.
const IGNORED_LABELS = new Set(['UNREAD', 'CHAT', 'YELLOW_STAR'])

export function isFolderLabel(id: string): boolean {
  return !IGNORED_LABELS.has(id) && !id.startsWith('CATEGORY_')
}

export function normalizeLabel(l: GmailLabel): ProviderFolder | null {
  if (!isFolderLabel(l.id)) return null
  const kind = SYSTEM_KINDS[l.id] ?? (l.type === 'system' ? null : 'custom')
  if (!kind) return null
  return {
    providerId: l.id,
    name: kind === 'custom' ? l.name : l.name.charAt(0) + l.name.slice(1).toLowerCase(),
    kind,
    unreadCount: l.messagesUnread ?? 0,
    totalCount: l.messagesTotal ?? 0,
  }
}

const header = (m: GmailMessage, name: string) => {
  const lower = name.toLowerCase()
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? null
}

const messageIds = (v: string | null) => (v ? (v.match(/<[^>]+>/g) ?? []) : [])

export function normalizeMessage(m: GmailMessage): ProviderMessage {
  const labels = m.labelIds ?? []
  const date = m.internalDate
    ? new Date(Number(m.internalDate))
    : new Date(header(m, 'Date') ?? Date.now())
  const attachments = m.payload ? collectAttachments(m.payload) : []
  return {
    providerMessageId: m.id,
    providerThreadId: m.threadId,
    rfc822MessageId: messageIds(header(m, 'Message-ID'))[0] ?? header(m, 'Message-ID'),
    inReplyTo: messageIds(header(m, 'In-Reply-To'))[0] ?? null,
    references: messageIds(header(m, 'References')),
    from: parseAddress(header(m, 'From')),
    to: parseAddressList(header(m, 'To')),
    cc: parseAddressList(header(m, 'Cc')),
    bcc: parseAddressList(header(m, 'Bcc')),
    replyTo: parseAddressList(header(m, 'Reply-To')),
    subject: header(m, 'Subject') ?? '',
    snippet: decodeEntities(m.snippet ?? ''),
    date: Number.isNaN(date.getTime()) ? new Date(0) : date,
    folderIds: labels.filter(isFolderLabel),
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    hasAttachments: attachments.some((a) => !a.inline),
    listUnsubscribe: header(m, 'List-Unsubscribe'),
    size: m.sizeEstimate ?? 0,
    attachments,
  }
}

// Gmail snippets arrive HTML-entity encoded.
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

const partHeader = (p: GmailPart, name: string) =>
  p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null

function collectAttachments(root: GmailPart): ProviderAttachment[] {
  const out: ProviderAttachment[] = []
  walk(root, (p) => {
    if (!p.filename && !p.body?.attachmentId) return
    if (!p.filename && /^text\/(plain|html)/.test(p.mimeType ?? '')) return
    const cid = partHeader(p, 'Content-ID')?.replace(/^<|>$/g, '') ?? null
    const disposition = partHeader(p, 'Content-Disposition') ?? ''
    out.push({
      filename: p.filename ?? '',
      mime: p.mimeType ?? 'application/octet-stream',
      size: p.body?.size ?? 0,
      providerAttachmentId: p.body?.attachmentId ?? null,
      contentId: cid,
      inline: !!cid && !/^attachment/i.test(disposition),
    })
  })
  return out
}

function walk(p: GmailPart, fn: (p: GmailPart) => void) {
  fn(p)
  p.parts?.forEach((c) => walk(c, fn))
}

/**
 * Picks the displayable body from a format=full payload. Parts whose data lives behind an
 * attachmentId (large bodies) are resolved through `loadPart`.
 */
export async function extractBody(
  root: GmailPart,
  loadPart: (attachmentId: string) => Promise<string>,
): Promise<RawBody> {
  let html: GmailPart | null = null
  let text: GmailPart | null = null
  walk(root, (p) => {
    if (p.filename) return
    if (!html && p.mimeType === 'text/html') html = p
    if (!text && p.mimeType === 'text/plain') text = p
  })

  const read = async (p: GmailPart | null) => {
    if (!p) return null
    const data =
      p.body?.data ?? (p.body?.attachmentId ? await loadPart(p.body.attachmentId) : undefined)
    if (!data) return null
    const charset = partHeader(p, 'Content-Type')?.match(/charset="?([^";\s]+)/i)?.[1]
    return decodeText(decodeBase64Url(data), charset)
  }

  return { html: await read(html), text: await read(text), attachments: collectAttachments(root) }
}
