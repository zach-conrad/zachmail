/**
 * First-party entities (tasks, links, later docs and notes): data ZachHub owns, with no provider
 * behind it. They share one write path and one sync shape so a module only declares its fields:
 *
 * - Clients write with `EntityOp`s (POST /api/entities). A put carries only the fields it
 *   changes, stamped with the device's HLC; the server keeps per field the highest stamp, so two
 *   devices editing different fields of one row both survive. Replays are harmless.
 * - Deletes are permanent tombstones (ids are UUIDs and never reused).
 * - Changes reach clients in `SyncDelta.entities`, keyed by namespaced kind ('tasks.task').
 */
import { isHlc, type Hlc } from './hlc'

/** Namespaced entity kind: '<module>.<entity>', e.g. 'tasks.task', 'hub.link'. */
export type EntityKind = string

/** A row as clients see it: `id` plus the module's declared fields (camelCase). */
export interface EntityRow {
  id: string
  [field: string]: unknown
}

export type EntityOp =
  | { kind: 'put'; entity: EntityKind; id: string; hlc: Hlc; fields: Record<string, unknown> }
  | { kind: 'delete'; entity: EntityKind; id: string; hlc: Hlc }

/** POST /api/entities */
export interface EntityOpsRequest {
  ops: EntityOp[]
}

export interface EntityOpsResponse {
  /** Indexes into the request's `ops`. Accepted includes writes that lost to newer ones. */
  accepted: number[]
  /** Never retried: the client drops these and refetches the row. */
  rejected: { index: number; error: string }[]
}

/** Per kind in `SyncDelta.entities`. */
export interface EntityDelta {
  upserts: EntityRow[]
  deletes: string[]
}

export type EntityDeltas = Record<EntityKind, EntityDelta>

export const MAX_ENTITY_OPS_PER_REQUEST = 500
const KIND = /^[a-z][a-z0-9]*\.[a-z][A-Za-z0-9]*$/
const FIELD = /^[a-z][A-Za-z0-9]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isEntityKind = (s: unknown): s is EntityKind => typeof s === 'string' && KIND.test(s)

export class InvalidEntityOpsError extends Error {
  override name = 'InvalidEntityOpsError'
}

function fail(msg: string): never {
  throw new InvalidEntityOpsError(msg)
}

/** Validates the shape of an untrusted /api/entities body; field values are the module's job. */
export function parseEntityOpsRequest(body: unknown): EntityOpsRequest {
  const ops = (body as { ops?: unknown } | null)?.ops
  if (!Array.isArray(ops)) fail('ops must be an array')
  if (ops.length > MAX_ENTITY_OPS_PER_REQUEST)
    fail(`at most ${MAX_ENTITY_OPS_PER_REQUEST} ops per request`)
  return {
    ops: ops.map((raw: unknown, i): EntityOp => {
      const o = (raw ?? {}) as Record<string, unknown>
      const where = `ops[${i}]`
      if (!isEntityKind(o.entity)) fail(`${where}.entity must look like 'module.entity'`)
      if (typeof o.id !== 'string' || !UUID.test(o.id)) fail(`${where}.id must be a UUID`)
      if (!isHlc(o.hlc)) fail(`${where}.hlc must be an HLC stamp`)
      if (o.kind === 'delete') return { kind: 'delete', entity: o.entity, id: o.id, hlc: o.hlc }
      if (o.kind !== 'put') fail(`${where}.kind must be 'put' or 'delete'`)
      const fields = o.fields
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        fail(`${where}.fields must be an object`)
      const names = Object.keys(fields)
      if (!names.length) fail(`${where}.fields is empty`)
      if (names.some((f) => !FIELD.test(f) || f === 'id'))
        fail(`${where}.fields has an invalid name`)
      return {
        kind: 'put',
        entity: o.entity,
        id: o.id,
        hlc: o.hlc,
        fields: fields as Record<string, unknown>,
      }
    }),
  }
}

/**
 * Cross-module references (plan §4): "this task came from that email". A first-party entity of
 * the hub itself, kind 'hub.link'. `title` is denormalized so a module can show the other side
 * without reading another module's tables.
 */
export interface LinkRow extends EntityRow {
  fromKind: EntityKind
  fromId: string
  toKind: EntityKind
  toId: string
  title: string
  createdAt: number
}

export const LINK_ENTITY = 'hub.link'
