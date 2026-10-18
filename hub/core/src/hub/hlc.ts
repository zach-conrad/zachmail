/**
 * Hybrid logical clocks for first-party data (ZACHHUB_PLAN.md §6). A stamp is
 * `<wall ms, 13 digits>-<counter, 4 hex>-<node>`, so plain string comparison orders stamps:
 * later wall time wins, then the higher counter, then the node id breaks exact ties. Every device
 * keeps one clock; every field write carries the stamp it was made at, and the server keeps, per
 * field, the value with the highest stamp (last writer wins per field).
 */

export type Hlc = string

export interface HlcClock {
  /** Wall-clock part of the last stamp issued or received. */
  ms: number
  counter: number
  /** Stable per device; no '-' (it separates the parts). */
  node: string
}

const HLC = /^\d{13}-[0-9a-f]{4}-[A-Za-z0-9_]{1,32}$/
const MAX_COUNTER = 0xffff
/** Stamps from further ahead than this are refused, so one bad clock can't win forever. */
export const MAX_HLC_DRIFT_MS = 24 * 60 * 60 * 1000

export const isHlc = (s: unknown): s is Hlc => typeof s === 'string' && HLC.test(s)

export function formatHlc(ms: number, counter: number, node: string): Hlc {
  return `${String(ms).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${node}`
}

export function parseHlc(stamp: Hlc): HlcClock {
  const [ms, counter, node] = stamp.split('-') as [string, string, string]
  return { ms: Number(ms), counter: parseInt(counter, 16), node }
}

export const newClock = (node: string): HlcClock => ({ ms: 0, counter: 0, node })

/** Issues a stamp for a local write, advancing `clock` in place. */
export function tick(clock: HlcClock, now = Date.now()): Hlc {
  if (now > clock.ms) {
    clock.ms = now
    clock.counter = 0
  } else if (clock.counter < MAX_COUNTER) {
    clock.counter++
  } else {
    // 65k writes in one millisecond: borrow the next millisecond rather than overflow.
    clock.ms++
    clock.counter = 0
  }
  return formatHlc(clock.ms, clock.counter, clock.node)
}

/** Folds in a stamp seen from elsewhere so this clock's next stamp sorts after it. */
export function receive(clock: HlcClock, stamp: Hlc, now = Date.now()): void {
  const r = parseHlc(stamp)
  if (r.ms > now + MAX_HLC_DRIFT_MS) return
  if (r.ms > clock.ms) {
    clock.ms = r.ms
    clock.counter = r.counter
  } else if (r.ms === clock.ms && r.counter > clock.counter) {
    clock.counter = r.counter
  }
}

/** Per-field stamps of a first-party row. */
export type FieldClocks = Record<string, Hlc>

/**
 * Merges a write into a row, keeping per field whichever value has the higher stamp. Returns
 * the fields that won (empty when the write changed nothing), so callers can persist only those.
 */
export function mergeFields<T extends Record<string, unknown>>(
  row: T,
  clocks: FieldClocks,
  fields: Partial<T>,
  stamp: Hlc,
): { row: T; clocks: FieldClocks; won: (keyof T & string)[] } {
  const won = (Object.keys(fields) as (keyof T & string)[]).filter(
    (f) => !(clocks[f] !== undefined && clocks[f] >= stamp),
  )
  if (!won.length) return { row, clocks, won }
  const next = { ...row }
  const nextClocks = { ...clocks }
  for (const f of won) {
    next[f] = fields[f] as T[typeof f]
    nextClocks[f] = stamp
  }
  return { row: next, clocks: nextClocks, won }
}
