/**
 * Triage operations: the client applies them to its replica in the same frame, queues them in
 * `pending_ops`, and POSTs them to /api/ops. The server mirrors the same effect, writes an
 * outbox row per account, and the worker applies it at the provider. Every client and the
 * server compute the effect with `opEffect`, so optimistic and server state agree.
 */
import type { FolderKind, Reminder, ReminderCondition, ThreadRow } from './protocol'

export type SimpleOpKind =
  'archive' | 'inbox' | 'trash' | 'spam' | 'read' | 'unread' | 'star' | 'unstar'

export type MailOp =
  | { kind: SimpleOpKind; threadIds: string[] }
  /** Add/remove folders by FolderRow id. "Move" is a label op that also removes the inbox. */
  | { kind: 'label'; threadIds: string[]; add: string[]; remove: string[] }
  /** Archive now, back to the inbox (unread) at `until` (epoch ms). */
  | { kind: 'snooze'; threadIds: string[]; until: number }
  /** Back to the inbox, unread, snooze and reminder cleared: what a due snooze does. */
  | { kind: 'unsnooze'; threadIds: string[] }
  /** At `at`, bring the thread back like a snooze (if `if_no_reply`, only if nobody answered). */
  | { kind: 'remind'; threadIds: string[]; at: number; condition: ReminderCondition }
  | { kind: 'unremind'; threadIds: string[] }

/** `id` is a client-generated UUID and doubles as the idempotency key. `at` is epoch ms. */
export interface OpEnvelope {
  id: string
  op: MailOp
  at: number
}

/** POST /api/ops */
export interface OpsRequest {
  ops: OpEnvelope[]
}

export interface OpsResponse {
  accepted: string[]
  /** Dropped ops (e.g. the threads no longer exist). Clients revert them from server state. */
  rejected: { id: string; error: string }[]
}

/**
 * Arrives in sync deltas as `upserts.ops`. Drop the matching pending op on `done`; on `failed`
 * drop it and show `error` (the server has already restored the provider's state).
 */
export interface OpStatusRow {
  id: string
  state: 'pending' | 'done' | 'failed'
  error: string | null
}

/** What an op does to one thread, in folder ids. */
export interface OpEffect {
  add: string[]
  remove: string[]
  unread?: boolean
  starred?: boolean
  /** undefined leaves it alone; null clears it. */
  snoozedUntil?: number | null
  reminder?: Reminder | null
}

export type FolderOfKind = (kind: FolderKind) => string | undefined

export const MAX_OPS_PER_REQUEST = 200
export const MAX_THREADS_PER_OP = 1000
/** Snooze and reminder times must fall before now + this. */
export const MAX_SNOOZE_MS = 5 * 365 * 24 * 60 * 60 * 1000

const SIMPLE_KINDS: readonly SimpleOpKind[] = [
  'archive',
  'inbox',
  'trash',
  'spam',
  'read',
  'unread',
  'star',
  'unstar',
]

/** The effect of `op` on threads of one account, given that account's folders by kind. */
export function opEffect(op: MailOp, folderOf: FolderOfKind): OpEffect {
  const ids = (...kinds: FolderKind[]) =>
    kinds.map(folderOf).filter((id): id is string => id !== undefined)
  switch (op.kind) {
    // Done, trash and back-to-inbox all end a snooze: the thread has been dealt with.
    case 'archive':
      return { add: [], remove: ids('inbox'), snoozedUntil: null }
    case 'inbox':
      return { add: ids('inbox'), remove: ids('trash', 'spam'), snoozedUntil: null }
    case 'trash':
      return { add: ids('trash'), remove: ids('inbox'), snoozedUntil: null }
    case 'spam':
      return { add: ids('spam'), remove: ids('inbox'), snoozedUntil: null }
    case 'read':
      return { add: [], remove: [], unread: false }
    case 'unread':
      return { add: [], remove: [], unread: true }
    case 'star':
      return { add: ids('starred'), remove: [], starred: true }
    case 'unstar':
      return { add: [], remove: ids('starred'), starred: false }
    case 'label':
      return { add: op.add, remove: op.remove }
    case 'snooze':
      return { add: [], remove: ids('inbox'), snoozedUntil: op.until }
    case 'unsnooze':
      return { add: ids('inbox'), remove: [], unread: true, snoozedUntil: null, reminder: null }
    case 'remind':
      return { add: [], remove: [], reminder: { at: op.at, condition: op.condition } }
    case 'unremind':
      return { add: [], remove: [], reminder: null }
  }
}

const sameReminder = (a: Reminder | null, b: Reminder | null) =>
  a === b || (!!a && !!b && a.at === b.at && a.condition === b.condition)

/** Applies an effect to a thread; returns the same object when nothing changes. */
export function applyEffect(thread: ThreadRow, effect: OpEffect): ThreadRow {
  const folders = new Set(thread.folderIds)
  effect.remove.forEach((id) => folders.delete(id))
  effect.add.forEach((id) => folders.add(id))
  const folderIds = [...folders]
  const unread = effect.unread ?? thread.unread
  const starred = effect.starred ?? thread.starred
  const snoozedUntil =
    effect.snoozedUntil !== undefined ? effect.snoozedUntil : (thread.snoozedUntil ?? null)
  const reminder = effect.reminder !== undefined ? effect.reminder : (thread.reminder ?? null)
  const sameFolders =
    folderIds.length === thread.folderIds.length && thread.folderIds.every((id) => folders.has(id))
  if (
    sameFolders &&
    unread === thread.unread &&
    starred === thread.starred &&
    snoozedUntil === (thread.snoozedUntil ?? null) &&
    sameReminder(reminder, thread.reminder ?? null)
  )
    return thread
  return { ...thread, folderIds, unread, starred, snoozedUntil, reminder }
}

/**
 * The op that undoes `op`. Label ops restore exactly; archive/trash/spam/snooze return to the
 * inbox, which is where triage commands start from. A removed reminder can't be restored from
 * the op alone, so `unremind` inverts to itself; clients that offer undo for it send a
 * `remind` with the values they had.
 */
export function invertOp(op: MailOp): MailOp {
  const { threadIds } = op
  switch (op.kind) {
    case 'archive':
    case 'trash':
    case 'spam':
    case 'snooze':
      return { kind: 'inbox', threadIds }
    case 'inbox':
    case 'unsnooze':
      return { kind: 'archive', threadIds }
    case 'read':
      return { kind: 'unread', threadIds }
    case 'unread':
      return { kind: 'read', threadIds }
    case 'star':
      return { kind: 'unstar', threadIds }
    case 'unstar':
      return { kind: 'star', threadIds }
    case 'label':
      return { kind: 'label', threadIds, add: op.remove, remove: op.add }
    case 'remind':
    case 'unremind':
      return { kind: 'unremind', threadIds }
  }
}

export class InvalidOpsError extends Error {
  override name = 'InvalidOpsError'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuidList = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && UUID.test(x))

function fail(msg: string): never {
  throw new InvalidOpsError(msg)
}

/** Validates an untrusted /api/ops body. */
export function parseOpsRequest(body: unknown): OpsRequest {
  const ops = (body as { ops?: unknown } | null)?.ops
  if (!Array.isArray(ops)) fail('ops must be an array')
  if (ops.length > MAX_OPS_PER_REQUEST) fail(`at most ${MAX_OPS_PER_REQUEST} ops per request`)
  return { ops: ops.map((e: unknown, i) => parseEnvelope(e, `ops[${i}]`)) }
}

function parseEnvelope(raw: unknown, where: string): OpEnvelope {
  const e = (raw ?? {}) as { id?: unknown; at?: unknown; op?: unknown }
  if (typeof e.id !== 'string' || !UUID.test(e.id)) fail(`${where}.id must be a UUID`)
  if (typeof e.at !== 'number' || !Number.isFinite(e.at)) fail(`${where}.at must be a number`)
  const op = (e.op ?? {}) as {
    kind?: unknown
    threadIds?: unknown
    add?: unknown
    remove?: unknown
    until?: unknown
    at?: unknown
    condition?: unknown
  }
  const { threadIds } = op
  if (!isUuidList(threadIds, MAX_THREADS_PER_OP) || threadIds.length === 0)
    fail(`${where}.op.threadIds must be 1-${MAX_THREADS_PER_OP} UUIDs`)
  if (op.kind === 'label') {
    const { add, remove } = op
    if (!isUuidList(add, 100) || !isUuidList(remove, 100))
      fail(`${where}.op add/remove must be folder UUIDs`)
    return { id: e.id, at: e.at, op: { kind: 'label', threadIds, add, remove } }
  }
  const time = (v: unknown, field: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v > Date.now() + MAX_SNOOZE_MS)
      fail(`${where}.op.${field} must be epoch ms within 5 years`)
    return v
  }
  if (op.kind === 'snooze')
    return { id: e.id, at: e.at, op: { kind: 'snooze', threadIds, until: time(op.until, 'until') } }
  if (op.kind === 'remind') {
    const { condition } = op
    if (condition !== 'always' && condition !== 'if_no_reply')
      fail(`${where}.op.condition must be always or if_no_reply`)
    return {
      id: e.id,
      at: e.at,
      op: { kind: 'remind', threadIds, at: time(op.at, 'at'), condition },
    }
  }
  if (op.kind === 'unsnooze' || op.kind === 'unremind')
    return { id: e.id, at: e.at, op: { kind: op.kind, threadIds } }
  if (!SIMPLE_KINDS.includes(op.kind as SimpleOpKind)) fail(`${where}.op.kind is unknown`)
  return { id: e.id, at: e.at, op: { kind: op.kind as SimpleOpKind, threadIds } }
}
