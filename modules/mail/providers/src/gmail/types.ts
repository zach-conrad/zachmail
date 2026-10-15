// Minimal shapes of the Gmail v1 resources we read.

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailPart
}

export interface GmailThread {
  id: string
  historyId?: string
  messages?: GmailMessage[]
}

export interface GmailLabel {
  id: string
  name: string
  type?: 'system' | 'user'
  messagesTotal?: number
  messagesUnread?: number
}

export interface GmailHistoryRecord {
  id: string
  messagesAdded?: { message: GmailMessage }[]
  messagesDeleted?: { message: GmailMessage }[]
  labelsAdded?: { message: GmailMessage; labelIds: string[] }[]
  labelsRemoved?: { message: GmailMessage; labelIds: string[] }[]
}
