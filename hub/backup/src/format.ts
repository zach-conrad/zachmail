import { Readable } from 'node:stream'
import { createGzip, gunzipSync } from 'node:zlib'
import { readContacts, type Queryable } from '@zachhub/db/server'
import { BACKUP_TABLES, DERIVED_TABLES } from './tables'

/**
 * A backup is gzipped NDJSON: a header line, one `{"t":table,"r":row}` line per row, and a
 * trailer with per-table counts. A file without its trailer was cut short and is refused.
 */
export const FORMAT = 'zachhub-backup'
export const VERSION = 1

export interface BackupHeader {
  format: typeof FORMAT
  version: number
  createdAt: string
  /** The one user exported, or null for the whole database (the nightly job). */
  userId: string | null
  tables: string[]
}

export interface BackupTrailer {
  end: true
  rows: Record<string, number>
}

export interface ExportOptions {
  userId?: string
  now?: Date
}

const ident = (s: string) => `"${s.replaceAll('"', '""')}"`

/** Yields the backup's lines, newline-terminated, reading one table at a time. */
export async function* backupLines(
  db: Queryable,
  opts: ExportOptions = {},
): AsyncGenerator<string> {
  const userId = opts.userId ?? null
  const header: BackupHeader = {
    format: FORMAT,
    version: VERSION,
    createdAt: (opts.now ?? new Date()).toISOString(),
    userId,
    tables: [...BACKUP_TABLES.map((t) => t.name), ...DERIVED_TABLES],
  }
  yield JSON.stringify(header) + '\n'
  const rows: Record<string, number> = {}
  for (const t of BACKUP_TABLES) {
    const scoped = userId && t.userScoped
    // to_jsonb(...)::text keeps Postgres's own JSON encoding; no parse and re-stringify here.
    const result = await db.query<{ r: string }>(
      `SELECT to_jsonb(x)::text AS r FROM ${ident(t.name)} x
       ${scoped ? 'WHERE x.user_id = $1' : ''} ORDER BY ${t.orderBy}`,
      scoped ? [userId] : [],
    )
    const prefix = `{"t":${JSON.stringify(t.name)},"r":`
    for (const { r } of result) yield prefix + r + '}\n'
    rows[t.name] = result.length
  }
  rows.contacts = 0
  const users = userId
    ? [userId]
    : (
        await db.query<{ id: string }>(`SELECT DISTINCT user_id AS id FROM accounts ORDER BY 1`)
      ).map((u) => u.id)
  for (const u of users) {
    for (const c of await readContacts(db, u)) {
      yield JSON.stringify({ t: 'contacts', r: { user_id: u, ...c } }) + '\n'
      rows.contacts++
    }
  }
  const trailer: BackupTrailer = { end: true, rows }
  yield JSON.stringify(trailer) + '\n'
}

/** The backup as a gzip stream (the settings download). */
export function backupStream(db: Queryable, opts: ExportOptions = {}): Readable {
  return Readable.from(backupLines(db, opts)).pipe(createGzip())
}

/** The whole backup in memory (the nightly upload needs its length up front). */
export async function exportBackup(
  db: Queryable,
  opts: ExportOptions = {},
): Promise<{ body: Buffer; rows: Record<string, number> }> {
  const chunks: Buffer[] = []
  for await (const c of backupStream(db, opts)) chunks.push(c as Buffer)
  const body = Buffer.concat(chunks)
  return { body, rows: parseBackup(body).trailer.rows }
}

export interface ParsedBackup {
  header: BackupHeader
  trailer: BackupTrailer
  rows: Map<string, Record<string, unknown>[]>
}

export class InvalidBackupError extends Error {}

/** Unzips and checks a backup: known format, a trailer, and counts that match. */
export function parseBackup(gz: Uint8Array): ParsedBackup {
  let text: string
  try {
    text = gunzipSync(gz).toString('utf8')
  } catch {
    throw new InvalidBackupError('Not a gzip file')
  }
  const lines = text.split('\n').filter((l) => l.length > 0)
  const first = lines.length ? (JSON.parse(lines[0]!) as Partial<BackupHeader>) : {}
  if (first.format !== FORMAT) throw new InvalidBackupError('Not a ZachHub backup')
  if (typeof first.version !== 'number' || first.version > VERSION)
    throw new InvalidBackupError(`Backup version ${first.version} is newer than this restore`)
  const last = JSON.parse(lines.at(-1)!) as Partial<BackupTrailer>
  if (lines.length < 2 || last.end !== true || !last.rows)
    throw new InvalidBackupError('Backup is truncated (no trailer)')
  const rows = new Map<string, Record<string, unknown>[]>()
  for (const line of lines.slice(1, -1)) {
    const { t, r } = JSON.parse(line) as { t: string; r: Record<string, unknown> }
    let list = rows.get(t)
    if (!list) rows.set(t, (list = []))
    list.push(r)
  }
  for (const [t, n] of Object.entries(last.rows)) {
    if ((rows.get(t)?.length ?? 0) !== n)
      throw new InvalidBackupError(
        `Backup is damaged: ${t} has ${rows.get(t)?.length ?? 0} of ${n} rows`,
      )
  }
  return { header: first as BackupHeader, trailer: last as BackupTrailer, rows }
}
