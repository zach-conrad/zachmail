import type { Db, Queryable } from '@zachhub/db/server'
import { parseBackup, type ParsedBackup } from './format'
import { BACKUP_TABLES } from './tables'

export interface RestoreOptions {
  /** Rewrite every row's user_id to this user (a new Supabase project has a new user id). */
  userId?: string
  /** Do everything, report the counts, then roll back. */
  dryRun?: boolean
}

export interface RestoreReport {
  /** Rows written per table. */
  restored: Record<string, number>
  /** Rows left out per table: already present, or pointing at a row that no longer exists. */
  skipped: Record<string, number>
  dryRun: boolean
}

const BATCH = 500
const ident = (s: string) => `"${s.replaceAll('"', '""')}"`

class Rollback extends Error {}

/**
 * Loads a backup into a database whose migrations are applied. Rows that already exist are
 * kept as they are (ON CONFLICT DO NOTHING), so restoring twice, or into a database that has
 * been partly rebuilt, is safe. Runs in one transaction.
 */
export async function restoreBackup(
  db: Db,
  backup: Uint8Array | ParsedBackup,
  opts: RestoreOptions = {},
): Promise<RestoreReport> {
  const parsed = backup instanceof Uint8Array ? parseBackup(backup) : backup
  const report: RestoreReport = { restored: {}, skipped: {}, dryRun: !!opts.dryRun }
  try {
    await db.transaction(async (tx) => {
      // Backup account id -> live account id, for accounts that were reconnected before the
      // restore ran and so already exist under a new id.
      const accountIds = new Map<string, string>()
      for (const t of BACKUP_TABLES) {
        let rows = parsed.rows.get(t.name) ?? []
        rows = rows.map((r) => {
          let row = t.onRestore ? t.onRestore(r) : { ...r }
          if (opts.userId && 'user_id' in row) row.user_id = opts.userId
          if (typeof row.account_id === 'string' && accountIds.has(row.account_id))
            row = { ...row, account_id: accountIds.get(row.account_id) }
          return row
        })
        let restored = 0
        if (rows.length) {
          const columns = await insertableColumns(tx, t.name)
          for (let i = 0; i < rows.length; i += BATCH)
            restored += await insertBatch(tx, t.name, columns, rows.slice(i, i + BATCH), t.requires)
        }
        report.restored[t.name] = restored
        report.skipped[t.name] = rows.length - restored
        if (t.name === 'accounts') {
          for (const a of rows) {
            const [live] = await tx.query<{ id: string }>(
              `SELECT id FROM accounts WHERE user_id = $1 AND provider = $2 AND email = $3`,
              [a.user_id, a.provider, a.email],
            )
            if (live && live.id !== a.id) accountIds.set(a.id as string, live.id)
          }
        }
      }
      if (opts.dryRun) throw new Rollback()
    })
  } catch (err) {
    if (!(err instanceof Rollback)) throw err
  }
  return report
}

async function insertableColumns(tx: Queryable, table: string): Promise<Set<string>> {
  const cols = await tx.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
    [table],
  )
  return new Set(cols.map((c) => c.name))
}

async function insertBatch(
  tx: Queryable,
  table: string,
  tableColumns: Set<string>,
  rows: Record<string, unknown>[],
  requires: Record<string, string> = {},
): Promise<number> {
  // Only columns the backup has: a column added since the backup keeps its default instead
  // of being forced to NULL, and a column dropped since is ignored.
  const present = new Set<string>()
  for (const r of rows) for (const k of Object.keys(r)) if (tableColumns.has(k)) present.add(k)
  const cols = [...present].map(ident)
  const where = Object.entries(requires).map(
    ([col, ref]) =>
      `(r.${ident(col)} IS NULL OR EXISTS (SELECT 1 FROM ${ident(ref)} x WHERE x.id = r.${ident(col)}))`,
  )
  const [res] = await tx.query<{ n: number }>(
    `WITH ins AS (
       INSERT INTO ${ident(table)} (${cols.join(', ')})
       SELECT ${cols.map((c) => `r.${c}`).join(', ')}
       FROM jsonb_populate_recordset(null::${ident(table)}, $1::text::jsonb) r
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM ins`,
    [JSON.stringify(rows)],
  )
  return res?.n ?? 0
}
