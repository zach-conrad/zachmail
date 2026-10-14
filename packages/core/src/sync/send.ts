/**
 * Sending goes through the server outbox like triage, delayed by the undo window (or until
 * `sendAt`), so undo-send and send-later work with every device closed.
 */
import { MAX_SNOOZE_MS } from './ops'
import type { Address } from './protocol'

/** POST /api/send. `id` is a client UUID: the idempotency key, the undo handle and the op id. */
export interface SendRequest {
  id: string
  accountId: string
  to: Address[]
  cc?: Address[]
  bcc?: Address[]
  subject: string
  html: string
  /** MessageRow id being answered; threads the reply and sets In-Reply-To/References. */
  replyToMessageId?: string
  /** Send later, epoch ms. */
  sendAt?: number
  /** Undo window, default 10 s. */
  undoMs?: number
  /** "Remind me if no reply": epoch ms to bring the thread back if nobody has answered. */
  remindAt?: number
}

export interface SendResponse {
  id: string
  /** When the worker will send it (epoch ms); DELETE /api/send/:id before then to undo. */
  sendAt: number
}

export const DEFAULT_UNDO_MS = 10_000
export const MAX_UNDO_MS = 30_000
export const MAX_RECIPIENTS = 100

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

/** Validates an untrusted /api/send body. */
export function parseSendRequest(body: unknown): SendRequest {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.id !== 'string' || !UUID.test(b.id)) fail('id must be a UUID')
  if (typeof b.accountId !== 'string' || !UUID.test(b.accountId)) fail('accountId must be a UUID')
  if (typeof b.subject !== 'string' || b.subject.length > 998) fail('subject is invalid')
  if (typeof b.html !== 'string' || b.html.length > 5_000_000) fail('html is invalid')
  const to = addresses(b.to, 'to')
  const cc = addresses(b.cc, 'cc')
  const bcc = addresses(b.bcc, 'bcc')
  if (!to.length && !cc.length && !bcc.length) fail('add at least one recipient')
  const replyToMessageId = b.replyToMessageId
  if (
    replyToMessageId !== undefined &&
    (typeof replyToMessageId !== 'string' || !UUID.test(replyToMessageId))
  )
    fail('replyToMessageId must be a UUID')
  if (b.sendAt !== undefined && (typeof b.sendAt !== 'number' || !Number.isFinite(b.sendAt)))
    fail('sendAt must be epoch ms')
  if (
    b.remindAt !== undefined &&
    (typeof b.remindAt !== 'number' ||
      !Number.isFinite(b.remindAt) ||
      b.remindAt > Date.now() + MAX_SNOOZE_MS)
  )
    fail('remindAt must be epoch ms within 5 years')
  const undoMs = b.undoMs ?? DEFAULT_UNDO_MS
  if (typeof undoMs !== 'number' || undoMs < 0 || undoMs > MAX_UNDO_MS)
    fail(`undoMs must be 0-${MAX_UNDO_MS}`)
  return {
    id: b.id,
    accountId: b.accountId,
    to,
    cc,
    bcc,
    subject: b.subject,
    html: b.html,
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(b.sendAt !== undefined ? { sendAt: b.sendAt as number } : {}),
    undoMs,
    ...(b.remindAt !== undefined ? { remindAt: b.remindAt as number } : {}),
  }
}
