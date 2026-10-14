/**
 * Sending goes through the server outbox like triage, delayed by the undo window (or until
 * `sendAt`), so undo-send and send-later work with every device closed.
 */
import { MAX_SNOOZE_MS } from './ops'
import type { Address } from './protocol'

/** POST /api/send. `id` is a client UUID: the idempotency key, the undo handle and the op id. */
export interface SendRequest extends OutgoingFields {
  id: string
  /** Send later, epoch ms. */
  sendAt?: number
  /** Undo window, default 10 s. */
  undoMs?: number
  /** "Remind me if no reply": epoch ms to bring the thread back if nobody has answered. */
  remindAt?: number
  /** The draft this message was composed in; deleted once the message has gone out. */
  draftId?: string
}

export interface SendResponse {
  id: string
  /** When the worker will send it (epoch ms); DELETE /api/send/:id before then to undo. */
  sendAt: number
}

export const DEFAULT_UNDO_MS = 10_000
export const MAX_UNDO_MS = 30_000
export const MAX_RECIPIENTS = 100
export const MAX_ATTACHMENTS = 20
/** Gmail's limit for a whole message is 25 MB; base64 makes files ~4/3 bigger on the wire. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024

/**
 * The Message-ID header of a send. Stable per op, so the copy that syncs back from the
 * provider can be recognised (and a "remind if no reply" attached to its thread).
 */
export const sentMessageId = (opId: string, fromEmail: string) =>
  `<${opId}@${fromEmail.split('@')[1] || 'zachmail.local'}>`

export class InvalidSendError extends Error {
  override name = 'InvalidSendError'
}

function fail(msg: string): never {
  throw new InvalidSendError(msg)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+$/

function addresses(v: unknown, field: string): Address[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_RECIPIENTS) fail(`${field} must be a list of addresses`)
  return v.map((a: unknown, i) => {
    const { email, name } = (a ?? {}) as { email?: unknown; name?: unknown }
    if (typeof email !== 'string' || !EMAIL.test(email)) fail(`${field}[${i}].email is invalid`)
    if (name !== undefined && typeof name !== 'string') fail(`${field}[${i}].name is invalid`)
    return name ? { email, name } : { email }
  })
}

/** The message part shared by sends and drafts. */
export interface OutgoingFields {
  accountId: string
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  html: string
  /** MessageRow id being answered; threads the reply and sets In-Reply-To/References. */
  replyToMessageId?: string
  /** Upload ids from POST /api/uploads. */
  attachments?: string[]
}

/** PUT /api/drafts/:id (id = client UUID). Saved to the provider a moment after typing stops. */
export type DraftRequest = OutgoingFields

function parseOutgoing(b: Record<string, unknown>, requireRecipient: boolean): OutgoingFields {
  if (typeof b.accountId !== 'string' || !UUID.test(b.accountId)) fail('accountId must be a UUID')
  if (typeof b.subject !== 'string' || b.subject.length > 998) fail('subject is invalid')
  if (typeof b.html !== 'string' || b.html.length > 5_000_000) fail('html is invalid')
  const to = addresses(b.to, 'to')
  const cc = addresses(b.cc, 'cc')
  const bcc = addresses(b.bcc, 'bcc')
  if (requireRecipient && !to.length && !cc.length && !bcc.length)
    fail('add at least one recipient')
  const replyToMessageId = b.replyToMessageId
  if (
    replyToMessageId !== undefined &&
    (typeof replyToMessageId !== 'string' || !UUID.test(replyToMessageId))
  )
    fail('replyToMessageId must be a UUID')
  const attachments = b.attachments ?? []
  if (
    !Array.isArray(attachments) ||
    attachments.length > MAX_ATTACHMENTS ||
    !attachments.every((a) => typeof a === 'string' && UUID.test(a))
  )
    fail(`attachments must be at most ${MAX_ATTACHMENTS} upload ids`)
  return {
    accountId: b.accountId,
    to,
    cc,
    bcc,
    subject: b.subject,
    html: b.html,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(attachments.length ? { attachments: attachments as string[] } : {}),
  }
}

/** Validates an untrusted /api/send body. */
export function parseSendRequest(body: unknown): SendRequest {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.id !== 'string' || !UUID.test(b.id)) fail('id must be a UUID')
  const fields = parseOutgoing(b, true)
  if (b.sendAt !== undefined && (typeof b.sendAt !== 'number' || !Number.isFinite(b.sendAt)))
    fail('sendAt must be epoch ms')
  const undoMs = b.undoMs ?? DEFAULT_UNDO_MS
  if (typeof undoMs !== 'number' || undoMs < 0 || undoMs > MAX_UNDO_MS)
    fail(`undoMs must be 0-${MAX_UNDO_MS}`)
  if (
    b.remindAt !== undefined &&
    (typeof b.remindAt !== 'number' ||
      !Number.isFinite(b.remindAt) ||
      b.remindAt > Date.now() + MAX_SNOOZE_MS)
  )
    fail('remindAt must be epoch ms within 5 years')
  if (b.draftId !== undefined && (typeof b.draftId !== 'string' || !UUID.test(b.draftId)))
    fail('draftId must be a UUID')
  return {
    id: b.id,
    ...fields,
    ...(b.sendAt !== undefined ? { sendAt: b.sendAt as number } : {}),
    undoMs,
    ...(b.remindAt !== undefined ? { remindAt: b.remindAt as number } : {}),
    ...(b.draftId ? { draftId: b.draftId as string } : {}),
  }
}

/** POST /api/uploads; then PUT the file's bytes to `uploadUrl` with its content type. */
export interface UploadRequest {
  filename: string
  mime: string
  size: number
}

export interface UploadResponse {
  id: string
  uploadUrl: string
}

export function parseUploadRequest(body: unknown): UploadRequest {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.filename !== 'string' || !b.filename || b.filename.length > 255)
    fail('filename is invalid')
  if (typeof b.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(b.mime)) fail('mime is invalid')
  if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size < 0) fail('size is invalid')
  if (b.size > MAX_ATTACHMENT_BYTES) fail('That file is too big to email')
  return { filename: b.filename, mime: b.mime, size: b.size }
}

/** Validates an untrusted draft body; drafts may have no recipients yet. */
export function parseDraftRequest(body: unknown): DraftRequest {
  return parseOutgoing((body ?? {}) as Record<string, unknown>, false)
}

/**
 * GET /api/contacts: people Zach has written to (weighted) or heard from, best first. Small
 * enough for clients to cache whole and autocomplete locally.
 */
export interface ContactRow {
  email: string
  name: string | null
  score: number
  lastAt: number
}
