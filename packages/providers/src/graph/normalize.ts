import type { Address } from '@zachmail/mime'
import type { FolderKind, ProviderAttachment, ProviderFolder, ProviderMessage } from '../types'
import type {
  GraphAttachment,
  GraphFolder,
  GraphMessage,
  GraphRecipient,
  WellKnownFolders,
} from './types'

/** Message fields the list and threading need (no body). */
export const MESSAGE_SELECT = [
  'id',
  'conversationId',
  'internetMessageId',
  'subject',
  'bodyPreview',
  'from',
  'sender',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'replyTo',
  'receivedDateTime',
  'sentDateTime',
  'parentFolderId',
  'isRead',
  'isDraft',
  'flag',
  'hasAttachments',
].join(',')

export const ATTACHMENT_SELECT = 'id,name,contentType,size,isInline'

export const FOLDER_KINDS: Partial<Record<keyof WellKnownFolders, FolderKind>> = {
  inbox: 'inbox',
  sentitems: 'sent',
  drafts: 'drafts',
  deleteditems: 'trash',
  junkemail: 'spam',
  archive: 'archive',
}

/** Folders that hold no mail Zach reads: the outbox, Teams/Skype history, sync conflicts. */
export const HIDDEN_FOLDERS: (keyof WellKnownFolders)[] = [
  'outbox',
  'conversationhistory',
  'syncissues',
]

/** Normalizes the folder list, dropping hidden folders and everything beneath them. */
export function normalizeFolders(folders: GraphFolder[], wk: WellKnownFolders): ProviderFolder[] {
  const hidden = new Set(HIDDEN_FOLDERS.map((k) => wk[k]).filter(Boolean))
  const parent = new Map(folders.map((f) => [f.id, f.parentFolderId]))
  const isHidden = (id: string | undefined, depth = 0): boolean =>
    !!id && depth < 32 && (hidden.has(id) || isHidden(parent.get(id), depth + 1))
  const kindOf = new Map<string, FolderKind>()
  for (const [k, kind] of Object.entries(FOLDER_KINDS)) {
    const id = wk[k as keyof WellKnownFolders]
    if (id) kindOf.set(id, kind)
  }
  return folders
    .filter((f) => !f['@removed'] && !isHidden(f.id))
    .map((f) => ({
      providerId: f.id,
      name: f.displayName ?? '',
      kind: kindOf.get(f.id) ?? 'custom',
      unreadCount: f.unreadItemCount ?? 0,
      totalCount: f.totalItemCount ?? 0,
    }))
}

function address(r: GraphRecipient | null | undefined): Address | null {
  const email = r?.emailAddress?.address?.trim()
  if (!email) return null
  const name = r?.emailAddress?.name?.trim()
  return name && name !== email ? { name, email } : { email }
}

const addresses = (rs: GraphRecipient[] | undefined) =>
  (rs ?? []).map(address).filter((a) => a !== null)

export function normalizeAttachment(a: GraphAttachment): ProviderAttachment {
  return {
    filename: a.name ?? '',
    mime: a.contentType || 'application/octet-stream',
    size: a.size ?? 0,
    providerAttachmentId: a.id,
    contentId: a.contentId?.replace(/^<|>$/g, '') || null,
    inline: !!a.isInline,
  }
}

export function normalizeMessage(
  m: GraphMessage,
  attachments: GraphAttachment[] = m.attachments ?? [],
): ProviderMessage {
  const date = new Date(m.receivedDateTime ?? m.sentDateTime ?? 0)
  return {
    providerMessageId: m.id,
    // Outlook groups a conversation by conversationId; it is the thread.
    providerThreadId: m.conversationId ?? m.id,
    rfc822MessageId: m.internetMessageId ?? null,
    // Not exposed as properties; replies still thread through rfc822MessageId.
    inReplyTo: null,
    references: [],
    from: address(m.from ?? m.sender),
    to: addresses(m.toRecipients),
    cc: addresses(m.ccRecipients),
    bcc: addresses(m.bccRecipients),
    replyTo: addresses(m.replyTo),
    subject: m.subject ?? '',
    snippet: (m.bodyPreview ?? '').replace(/\s+/g, ' ').trim(),
    date: Number.isNaN(date.getTime()) ? new Date(0) : date,
    folderIds: m.parentFolderId ? [m.parentFolderId] : [],
    unread: m.isRead === false,
    starred: m.flag?.flagStatus === 'flagged',
    hasAttachments: !!m.hasAttachments,
    listUnsubscribe: null,
    size: 0,
    attachments: attachments.map(normalizeAttachment),
  }
}
