/**
 * The server half of first-party entities (core hub/entities.ts): one write path and one read
 * path for every module's tables, driven by a declaration of each table's fields. Modules never
 * write their own merge SQL, so the per-field last-writer-wins rule is the same everywhere.
 */
import {
  LINK_ENTITY,
  formatHlc,
  type EntityDeltas,
  type EntityKind,
  type EntityOp,
  type EntityOpsResponse,
  type EntityRow,
  type Hlc,
} from '@zachhub/core'
import type { Queryable } from './sql'
import { recordChanges } from './sync'

export type FieldType =
  'text' | 'int' | 'float' | 'bool' | 'timestamptz' | 'date' | 'uuid' | 'jsonb'

export interface FieldSpec {
  column: string
  type: FieldType
  /** Accepts null (and starts null on create when not given). */
  nullable?: boolean
  /** Required on the put that creates the row. */
  required?: boolean
}

/** A module's declaration of one first-party table. */
export interface EntityTable {
  kind: EntityKind
  /** Schema-qualified, trusted constant: 'tasks.tasks'. Needs `firstPartyColumns()`. */
  table: string
  /** Client field name (camelCase) → column. `id` is implicit. */
  fields: Record<string, FieldSpec>
  /** Extra checks on a put's fields (after type checks); return an error to reject. */
  validate?: (fields: Record<string, unknown>, creating: boolean) => string | null
}

const IDENT = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TEXT = 100_000

/** Throws on a declaration that could inject SQL; run once at startup by the registry. */
export function checkEntityTable(t: EntityTable): EntityTable {
  if (!IDENT.test(t.table)) throw new Error(`Bad table name ${t.table}`)
  for (const [name, f] of Object.entries(t.fields))
    if (!IDENT.test(f.column) || !/^[a-z][A-Za-z0-9]*$/.test(name) || name === 'id')
      throw new Error(`Bad field ${t.kind}.${name}`)
  return t
}

function checkValue(f: FieldSpec, v: unknown): string | null {
  if (v === null) return f.nullable ? null : 'may not be null'
  switch (f.type) {
    case 'text':
      return typeof v === 'string' && v.length <= MAX_TEXT ? null : 'must be text'
    case 'int':
      return Number.isSafeInteger(v) ? null : 'must be an integer'
    case 'float':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a number'
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be true or false'
    case 'timestamptz':
      return Number.isSafeInteger(v) ? null : 'must be epoch ms'
    case 'date':
      return typeof v === 'string' && DATE.test(v) ? null : 'must be YYYY-MM-DD'
    case 'uuid':
      return typeof v === 'string' && UUID.test(v) ? null : 'must be a UUID'
    case 'jsonb':
      // Objects and arrays only: a bare string would reach Postgres as unparsed text.
      if (typeof v !== 'object') return 'must be an object or array'
      return JSON.stringify(v).length <= MAX_TEXT ? null : 'is too large'
  }
}

/** SQL for a parameter of this field's type; timestamps travel as epoch ms. */
function param(f: FieldSpec, n: number) {
  switch (f.type) {
    case 'timestamptz':
      return `to_timestamp($${n}::float8 / 1000)`
    case 'jsonb':
      return `$${n}::jsonb`
    case 'int':
      return `$${n}::int`
    case 'float':
      return `$${n}::float8`
    case 'bool':
      return `$${n}::boolean`
    case 'date':
      return `$${n}::date`
    case 'uuid':
      return `$${n}::uuid`
    case 'text':
      return `$${n}::text`
  }
}

/** SELECT list giving clients' row shape (camelCase, timestamps as epoch ms, dates as text). */
function selectList(t: EntityTable) {
  const cols = Object.entries(t.fields).map(([name, f]) => {
    const expr =
      f.type === 'timestamptz'
        ? `(extract(epoch from ${f.column}) * 1000)::float8`
        : f.type === 'date'
          ? `${f.column}::text`
          : f.column
    return `${expr} AS "${name}"`
  })
  return ['id', ...cols].join(', ')
}

export class EntityRegistry {
  private byKind = new Map<EntityKind, EntityTable>()

  constructor(tables: EntityTable[]) {
    for (const t of tables) {
      if (this.byKind.has(t.kind)) throw new Error(`Entity ${t.kind} registered twice`)
      this.byKind.set(t.kind, checkEntityTable(t))
    }
  }

  get(kind: EntityKind) {
    return this.byKind.get(kind)
  }

  get tables() {
    return [...this.byKind.values()]
  }
}

/** The hub's own entities; modules add theirs alongside (see @zachhub/kernel). */
export const HUB_ENTITIES: EntityTable[] = [
  {
    kind: LINK_ENTITY,
    table: 'hub.links',
    fields: {
      fromKind: { column: 'from_kind', type: 'text', required: true },
      fromId: { column: 'from_id', type: 'text', required: true },
      toKind: { column: 'to_kind', type: 'text', required: true },
      toId: { column: 'to_id', type: 'text', required: true },
      title: { column: 'title', type: 'text' },
      createdAt: { column: 'created_at', type: 'timestamptz' },
    },
  },
]

/**
 * Applies client (or server-made) entity ops in one transaction the caller owns. Each put keeps,
 * per field, whichever value carries the higher stamp; deletes leave a tombstone that later puts
 * for the same id can't get past. Every row that changed is logged to `changes`.
 */
export async function applyEntityOps(
  tx: Queryable,
  userId: string,
  registry: EntityRegistry,
  ops: EntityOp[],
): Promise<EntityOpsResponse> {
  const res: EntityOpsResponse = { accepted: [], rejected: [] }
  const changed = new Map<EntityKind, { upsert: Set<string>; delete: Set<string> }>()
  const mark = (kind: EntityKind, id: string, op: 'upsert' | 'delete') => {
    const c = changed.get(kind) ?? { upsert: new Set(), delete: new Set() }
    changed.set(kind, c)
    c[op].add(id)
    if (op === 'delete') c.upsert.delete(id)
  }

  for (const [index, op] of ops.entries()) {
    const t = registry.get(op.entity)
    if (!t) {
      res.rejected.push({ index, error: `Unknown entity ${op.entity}` })
      continue
    }
    const error = await applyOne(tx, userId, t, op, mark)
    if (error) res.rejected.push({ index, error })
    else res.accepted.push(index)
  }

  for (const [kind, c] of changed) {
    await recordChanges(tx, userId, kind, [...c.upsert], 'upsert')
    await recordChanges(tx, userId, kind, [...c.delete], 'delete')
  }
  return res
}

async function applyOne(
  tx: Queryable,
  userId: string,
  t: EntityTable,
  op: EntityOp,
  mark: (kind: EntityKind, id: string, op: 'upsert' | 'delete') => void,
): Promise<string | null> {
  const [tomb] = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM hub.tombstones WHERE kind = $1 AND id = $2`,
    [t.kind, op.id],
  )
  if (tomb) return tomb.user_id === userId ? null : 'Not found'

  // As text: the postgres.js adapter hands jsonb back unparsed, PGlite parses it.
  const [row] = await tx.query<{ user_id: string; field_hlc: string }>(
    `SELECT user_id, field_hlc::text AS field_hlc FROM ${t.table} WHERE id = $1 FOR UPDATE`,
    [op.id],
  )
  if (row && row.user_id !== userId) return 'Not found'

  if (op.kind === 'delete') {
    await tx.query(
      `INSERT INTO hub.tombstones (kind, id, user_id, hlc) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [t.kind, op.id, userId, op.hlc],
    )
    if (row) await tx.query(`DELETE FROM ${t.table} WHERE id = $1`, [op.id])
    mark(t.kind, op.id, 'delete')
    return null
  }

  for (const [name, v] of Object.entries(op.fields)) {
    const f = t.fields[name]
    if (!f) return `Unknown field ${t.kind}.${name}`
    const bad = checkValue(f, v)
    if (bad) return `${name} ${bad}`
  }
  const creating = !row
  if (creating) {
    const missing = Object.entries(t.fields).find(([n, f]) => f.required && !(n in op.fields))
    if (missing) return `${missing[0]} is required`
  }
  const invalid = t.validate?.(op.fields, creating)
  if (invalid) return invalid

  const clocks: Record<string, Hlc> = row ? JSON.parse(row.field_hlc) : {}
  const won = Object.keys(op.fields).filter(
    (n) => !(clocks[n] !== undefined && clocks[n] >= op.hlc),
  )
  if (!won.length) return null
  const stamps = Object.fromEntries(won.map((n) => [n, op.hlc]))
  // jsonb params go as objects: both adapters serialize them (a string would be stored as a
  // JSON string).
  const values = won.map((n) => op.fields[n])

  if (creating) {
    const cols = won.map((n) => t.fields[n]!.column)
    const params = won.map((n, i) => param(t.fields[n]!, i + 4))
    const inserted = await tx.query(
      `INSERT INTO ${t.table} (id, user_id, field_hlc${cols.map((c) => `, ${c}`).join('')})
       VALUES ($1, $2, $3::jsonb${params.map((p) => `, ${p}`).join('')})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [op.id, userId, stamps, ...values],
    )
    // Lost a race with a concurrent create of the same id: merge into that row instead.
    if (!inserted.length) return applyOne(tx, userId, t, op, mark)
  } else {
    const sets = won.map((n, i) => `${t.fields[n]!.column} = ${param(t.fields[n]!, i + 3)}`)
    await tx.query(
      `UPDATE ${t.table} SET ${sets.join(', ')}, field_hlc = field_hlc || $2::jsonb,
         updated_at = now() WHERE id = $1`,
      [op.id, stamps, ...values],
    )
  }
  mark(t.kind, op.id, 'upsert')
  return null
}

/** Rows of one kind by id, in the client shape. Ids not found are simply left out. */
export async function loadEntities(
  db: Queryable,
  userId: string,
  t: EntityTable,
  ids: string[] | null,
): Promise<EntityRow[]> {
  if (ids && !ids.length) return []
  return db.query<EntityRow>(
    `SELECT ${selectList(t)} FROM ${t.table} WHERE user_id = $1
     ${ids ? 'AND id = ANY($2::uuid[])' : ''} ORDER BY id`,
    ids ? [userId, ids] : [userId],
  )
}

/**
 * Builds `SyncDelta.entities` from the latest change per (kind, id) in a window. Kinds no
 * longer registered (a removed module) are skipped.
 */
export async function readEntityDeltas(
  db: Queryable,
  userId: string,
  registry: EntityRegistry,
  latest: { entity: string; entity_id: string; op: 'upsert' | 'delete' }[],
): Promise<EntityDeltas> {
  const want = new Map<EntityKind, string[]>()
  const out: EntityDeltas = {}
  const entry = (kind: string) => (out[kind] ??= { upserts: [], deletes: [] })
  for (const c of latest) {
    if (!registry.get(c.entity)) continue
    if (c.op === 'delete') entry(c.entity).deletes.push(c.entity_id)
    else want.set(c.entity, [...(want.get(c.entity) ?? []), c.entity_id])
  }
  for (const [kind, ids] of want) {
    const rows = await loadEntities(db, userId, registry.get(kind)!, ids)
    const e = entry(kind)
    e.upserts = rows
    // Logged as upserted but gone now (deleted in a window not read yet): tell clients.
    const found = new Set(rows.map((r) => r.id))
    e.deletes.push(...ids.filter((id) => !found.has(id)))
  }
  return out
}

/** A stamp for server-made writes (worker jobs, the API acting for the user). */
export const serverHlc = (now = Date.now()): Hlc => formatHlc(now, 0, 'server')
