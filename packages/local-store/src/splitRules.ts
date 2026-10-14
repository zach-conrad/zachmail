import type { SplitRuleRow } from '@zachmail/core'
import type { SqlDriver } from './driver'

export const SPLIT_RULES_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS split_rules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS split_rules_pending (id TEXT PRIMARY KEY, data TEXT, at INTEGER NOT NULL);
`

export const SPLIT_RULES_DROP = /* sql */ `
DROP TABLE IF EXISTS split_rules;
DROP TABLE IF EXISTS split_rules_pending;
`

/** A local rule edit not yet accepted by the server; `rule` null is a delete. */
export interface PendingSplitRule {
  id: string
  rule: SplitRuleRow | null
}

/**
 * Split rules in the replica: the synced rows plus local edits waiting to be sent. Reads see
 * the edits on top, so a saved rule re-splits the inbox at once, online or not, and a sync
 * that lands before the edit is sent cannot undo it on screen.
 */
export class SplitRuleTable {
  constructor(private db: SqlDriver) {}

  /** Synced rules with pending edits applied. */
  effective(): SplitRuleRow[] {
    const byId = new Map<string, SplitRuleRow>()
    for (const r of this.db.all<{ id: string; data: string }>(`SELECT id, data FROM split_rules`))
      byId.set(r.id, JSON.parse(r.data) as SplitRuleRow)
    for (const p of this.pending()) {
      if (p.rule) byId.set(p.id, p.rule)
      else byId.delete(p.id)
    }
    return [...byId.values()]
  }

  /** Applies synced rows; returns whether anything changed. Runs inside the caller's tx. */
  applySynced(upserts: readonly SplitRuleRow[] = [], deletes: readonly string[] = []): boolean {
    if (!upserts.length && !deletes.length) return false
    if (upserts.length)
      this.db.run(
        `INSERT OR REPLACE INTO split_rules (id, data)
         SELECT value ->> 'id', json(value) FROM json_each(?)`,
        [JSON.stringify(upserts)],
      )
    if (deletes.length)
      this.db.run(`DELETE FROM split_rules WHERE id IN (SELECT value FROM json_each(?))`, [
        JSON.stringify(deletes),
      ])
    return true
  }

  clearSynced(): void {
    this.db.run(`DELETE FROM split_rules`)
  }

  /** Records a local save (rule) or delete (null). The latest edit per rule wins. */
  edit(id: string, rule: SplitRuleRow | null): void {
    this.db.run(`INSERT OR REPLACE INTO split_rules_pending (id, data, at) VALUES (?, ?, ?)`, [
      id,
      rule ? JSON.stringify(rule) : null,
      Date.now(),
    ])
  }

  pending(): PendingSplitRule[] {
    return this.db
      .all<{ id: string; data: string | null }>(
        `SELECT id, data FROM split_rules_pending ORDER BY at, id`,
      )
      .map((r) => ({ id: r.id, rule: r.data ? (JSON.parse(r.data) as SplitRuleRow) : null }))
  }

  /**
   * The server accepted `sent`. Drops the pending edit unless a newer one replaced it while
   * the request was in flight, and records the accepted state as synced so the screen does
   * not flicker back to the old rule before the next delta arrives.
   */
  ack(sent: PendingSplitRule): void {
    const cur = this.db.all<{ data: string | null }>(
      `SELECT data FROM split_rules_pending WHERE id = ?`,
      [sent.id],
    )[0]
    const sentData = sent.rule ? JSON.stringify(sent.rule) : null
    if (cur && cur.data === sentData)
      this.db.run(`DELETE FROM split_rules_pending WHERE id = ?`, [sent.id])
    if (sent.rule) this.applySynced([sent.rule])
    else this.applySynced([], [sent.id])
  }

  /** The server refused the edit for good: forget it, so the synced rule shows again. */
  reject(id: string): void {
    this.db.run(`DELETE FROM split_rules_pending WHERE id = ?`, [id])
  }
}
