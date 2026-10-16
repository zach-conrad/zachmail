// Minimal shapes of the Microsoft Graph v1.0 mail resources we read.

export interface GraphRecipient {
  emailAddress?: { name?: string; address?: string }
}

export interface GraphMessage {
  id: string
  conversationId?: string
  internetMessageId?: string
  subject?: string | null
  bodyPreview?: string
  from?: GraphRecipient | null
  sender?: GraphRecipient | null
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  replyTo?: GraphRecipient[]
  receivedDateTime?: string
  sentDateTime?: string
  parentFolderId?: string
  isRead?: boolean
  isDraft?: boolean
  flag?: { flagStatus?: 'notFlagged' | 'flagged' | 'complete' }
  hasAttachments?: boolean
  body?: { contentType?: 'html' | 'text'; content?: string }
  attachments?: GraphAttachment[]
  /** Present on delta entries for messages that left the folder. */
  '@removed'?: { reason?: string }
}

export interface GraphAttachment {
  id: string
  name?: string | null
  contentType?: string | null
  size?: number
  isInline?: boolean
  contentId?: string | null
}

export interface GraphFolder {
  id: string
  displayName?: string
  parentFolderId?: string
  unreadItemCount?: number
  totalItemCount?: number
  '@removed'?: { reason?: string }
}

export interface GraphPage<T> {
  value?: T[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

/** Ids of the well-known folders, resolved once per account (they never change). */
export interface WellKnownFolders {
  inbox?: string
  sentitems?: string
  drafts?: string
  deleteditems?: string
  junkemail?: string
  archive?: string
  outbox?: string
  conversationhistory?: string
  syncissues?: string
}
