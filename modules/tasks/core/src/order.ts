/**
 * Manual order: fractional index keys, so a drag or ⌘↑ writes one row and never renumbers a
 * list. Keys compare by code unit (`<`), which is also SQLite's BINARY collation; the Postgres
 * column must be COLLATE "C".
 */
import { generateKeyBetween } from 'fractional-indexing'

export const comparePosition = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A key strictly between `before` and `after` (either may be null for an open end). */
export function positionBetween(before: string | null, after: string | null): string {
  // Two devices can mint the same key; ties then fall back to id order, and a reorder heals them.
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null)
  return generateKeyBetween(before, after)
}

/** A key after every item in `items`. */
export function positionAtEnd(items: readonly { position: string }[]): string {
  let last: string | null = null
  for (const i of items) if (last === null || i.position > last) last = i.position
  return generateKeyBetween(last, null)
}

/** A key before every item in `items`. */
export function positionAtStart(items: readonly { position: string }[]): string {
  let first: string | null = null
  for (const i of items) if (first === null || i.position < first) first = i.position
  return generateKeyBetween(null, first)
}

/**
 * The new position for moving `sorted[index]` one step up (-1) or down (+1) among `sorted`
 * (already in position order). Null at either end.
 */
export function positionForStep(
  sorted: readonly { position: string }[],
  index: number,
  dir: -1 | 1,
): string | null {
  const target = index + dir
  if (target < 0 || target >= sorted.length) return null
  // Moving up lands between target-1 and target; moving down between target and target+1.
  const before = dir === -1 ? (sorted[target - 1]?.position ?? null) : sorted[target]!.position
  const after = dir === -1 ? sorted[target]!.position : (sorted[target + 1]?.position ?? null)
  return positionBetween(before, after)
}

/** Position for dropping an item at `index` of `sorted` (the list without the dragged item). */
export function positionForDrop(sorted: readonly { position: string }[], index: number): string {
  return positionBetween(sorted[index - 1]?.position ?? null, sorted[index]?.position ?? null)
}
