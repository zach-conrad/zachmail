/**
 * Triage operations: the client applies them to its replica in the same frame, queues them in
 * `pending_ops`, and POSTs them to /api/ops. The server mirrors the same effect, writes an
 * outbox row per account, and the worker applies it at the provider. Every client and the
 * server compute the effect with `opEffect`, so optimistic and server state agree.
 */
import type { FolderKind, ThreadRow } from './protocol'

export type SimpleOpKind =
  | 'archive'
  | 'inbox'
  | 'trash'
  | 'spam'
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  /** Archive, and keep archiving the thread when new replies arrive. */
  | 'mute'
  | 'unmute'

export type MailOp =
  | { kind: SimpleOpKind; threadIds: string[] }
  /** Add/remove folders by FolderRow id. "Move" is a label op that also removes the inbox. */
  | { kind: 'label'; threadIds: string[]; add: string[]; remove: string[] }

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
 * Arrives in sync deltas as `SyncDelta.ops`. Drop the matching pending op on `done`; on `failed`
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
  muted?: boolean
}

export type FolderOfKind = (kind: FolderKind) => string | undefined

export const MAX_OPS_PER_REQUEST = 200
export const MAX_THREADS_PER_OP = 1000

const SIMPLE_KINDS: readonly SimpleOpKind[] = [
  'archive',
  'inbox',
  'trash',
  'spam',
  'read',
  'unread',
  'star',
  'unstar',
  'mute',
  'unmute',
]

/** The effect of `op` on threads of one account, given that account's folders by kind. */
export function opEffect(op: MailOp, folderOf: FolderOfKind): OpEffect {
  const ids = (...kinds: FolderKind[]) =>
    kinds.map(folderOf).filter((id): id is string => id !== undefined)
  switch (op.kind) {
    case 'archive':
      return { add: [], remove: ids('inbox') }
    case 'inbox':
      return { add: ids('inbox'), remove: ids('trash', 'spam') }
    case 'trash':
      return { add: ids('trash'), remove: ids('inbox') }
    case 'spam':
      return { add: ids('spam'), remove: ids('inbox') }
    case 'read':
      return { add: [], remove: [], unread: false }
    case 'unread':
      return { add: [], remove: [], unread: true }
    case 'star':
      return { add: ids('starred'), remove: [], starred: true }
    case 'unstar':
      return { add: [], remove: ids('starred'), starred: false }
    case 'mute':
      return { add: [], remove: ids('inbox'), muted: true }
    case 'unmute':
      // Back to the inbox too, so unmute is an exact undo of mute.
      return { add: ids('inbox'), remove: [], muted: false }
    case 'label':
      return { add: op.add, remove: op.remove }
  }
}

/** Applies an effect to a thread; returns the same object when nothing changes. */
export function applyEffect(thread: ThreadRow, effect: OpEffect): ThreadRow {
  const folders = new Set(thread.folderIds)
  effect.remove.forEach((id) => folders.delete(id))
  effect.add.forEach((id) => folders.add(id))
  const folderIds = [...folders]
  const unread = effect.unread ?? thread.unread
  const starred = effect.starred ?? thread.starred
  const muted = effect.muted ?? thread.muted ?? false
  const sameFolders =
    folderIds.length === thread.folderIds.length && thread.folderIds.every((id) => folders.has(id))
  if (
    sameFolders &&
    unread === thread.unread &&
    starred === thread.starred &&
    muted === (thread.muted ?? false)
  )
    return thread
  return { ...thread, folderIds, unread, starred, muted }
}

/**
 * The op that undoes `op`. Label ops restore exactly; archive/trash/spam return to the inbox,
 * which is where triage commands start from.
 */
export function invertOp(op: MailOp): MailOp {
  const { threadIds } = op
  switch (op.kind) {
    case 'archive':
    case 'trash':
    case 'spam':
      return { kind: 'inbox', threadIds }
    case 'inbox':
      return { kind: 'archive', threadIds }
    case 'read':
      return { kind: 'unread', threadIds }
    case 'unread':
      return { kind: 'read', threadIds }
    case 'star':
      return { kind: 'unstar', threadIds }
    case 'unstar':
      return { kind: 'star', threadIds }
    case 'mute':
      return { kind: 'unmute', threadIds }
    case 'unmute':
      return { kind: 'mute', threadIds }
    case 'label':
      return { kind: 'label', threadIds, add: op.remove, remove: op.add }
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
  if (!SIMPLE_KINDS.includes(op.kind as SimpleOpKind)) fail(`${where}.op.kind is unknown`)
  return { id: e.id, at: e.at, op: { kind: op.kind as SimpleOpKind, threadIds } }
}
