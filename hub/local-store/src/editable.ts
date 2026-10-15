import type { SqlDriver } from './driver'

/** A local edit not yet accepted by the server; `value` null is a delete. */
export interface PendingEdit<T> {
  id: string
  value: T | null
}

/** Tables for one editable entity: synced rows and unsent local edits. */
export const editableSchema = (table: string) => /* sql */ `
CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ${table}_pending (id TEXT PRIMARY KEY, data TEXT, at INTEGER NOT NULL);
`

export const editableDrop = (table: string) => /* sql */ `
DROP TABLE IF EXISTS ${table};
DROP TABLE IF EXISTS ${table}_pending;
`

/**
 * ZachMail-only rows the user edits (snippets, nudge dismissals): synced rows plus local
 * edits waiting to be sent. Reads see the edits on top, so a change shows at once, online or
 * not, and a delta that lands before the edit is sent cannot undo it on screen. Same model as
 * split rules (splitRules.ts).
 */
export class EditableTable<T extends { id: string }> {
  constructor(
    private db: SqlDriver,
    private table: string,
  ) {}

  /** Synced rows with pending edits applied. */
  effective(): T[] {
    const byId = new Map<string, T>()
    for (const r of this.db.all<{ id: string; data: string }>(`SELECT id, data FROM ${this.table}`))
      byId.set(r.id, JSON.parse(r.data) as T)
    for (const p of this.pending()) {
      if (p.value) byId.set(p.id, p.value)
      else byId.delete(p.id)
    }
    return [...byId.values()]
  }

  /** Applies synced rows; returns whether anything changed. Runs inside the caller's tx. */
  applySynced(upserts: readonly T[] = [], deletes: readonly string[] = []): boolean {
    if (!upserts.length && !deletes.length) return false
    if (upserts.length)
      this.db.run(
        `INSERT OR REPLACE INTO ${this.table} (id, data)
         SELECT value ->> 'id', json(value) FROM json_each(?)`,
        [JSON.stringify(upserts)],
      )
    if (deletes.length)
      this.db.run(`DELETE FROM ${this.table} WHERE id IN (SELECT value FROM json_each(?))`, [
        JSON.stringify(deletes),
      ])
    return true
  }

  clearSynced(): void {
    this.db.run(`DELETE FROM ${this.table}`)
  }

  /** Records a local save (value) or delete (null). The latest edit per id wins. */
  edit(id: string, value: T | null): void {
    this.db.run(`INSERT OR REPLACE INTO ${this.table}_pending (id, data, at) VALUES (?, ?, ?)`, [
      id,
      value ? JSON.stringify(value) : null,
      Date.now(),
    ])
  }

  pending(): PendingEdit<T>[] {
    return this.db
      .all<{ id: string; data: string | null }>(
        `SELECT id, data FROM ${this.table}_pending ORDER BY at, id`,
      )
      .map((r) => ({ id: r.id, value: r.data ? (JSON.parse(r.data) as T) : null }))
  }

  /**
   * The server accepted `sent`: drop the pending edit unless a newer one replaced it in
   * flight, and record the accepted state as synced so nothing flickers before the delta.
   */
  ack(sent: PendingEdit<T>): void {
    const cur = this.db.all<{ data: string | null }>(
      `SELECT data FROM ${this.table}_pending WHERE id = ?`,
      [sent.id],
    )[0]
    const sentData = sent.value ? JSON.stringify(sent.value) : null
    if (cur && cur.data === sentData)
      this.db.run(`DELETE FROM ${this.table}_pending WHERE id = ?`, [sent.id])
    if (sent.value) this.applySynced([sent.value])
    else this.applySynced([], [sent.id])
  }

  /** The server refused the edit for good: forget it, so the synced row shows again. */
  reject(id: string): void {
    this.db.run(`DELETE FROM ${this.table}_pending WHERE id = ?`, [id])
  }
}
