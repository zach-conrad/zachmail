import sqlite3InitModule, { type Database, type PreparedStatement } from '@sqlite.org/sqlite-wasm'
import type { SqlDriver, SqlValue } from './driver'

// forceReinitIfPreviouslyFailed is supported at runtime but missing from the bundled types.
const SAH_POOL = { name: 'zachmail', initialCapacity: 6, forceReinitIfPreviouslyFailed: true }

export interface OpenOptions {
  /** OPFS file name; omit for an in-memory database (tests, or when OPFS is unavailable). */
  file?: string
}

export interface OpenedDriver {
  driver: SqlDriver
  /** 'opfs' when the database persists across reloads, 'memory' otherwise. */
  storage: 'opfs' | 'memory'
}

/**
 * Opens SQLite (wasm) with the OPFS SyncAccessHandle-pool VFS: synchronous, fast, and no
 * COOP/COEP headers needed. Must run in a dedicated Web Worker for OPFS. Falls back to memory
 * when OPFS is unavailable (old browser, private mode, or another tab already holds the pool).
 */
export async function openSqliteWasm(opts: OpenOptions = {}): Promise<OpenedDriver> {
  const sqlite3 = await sqlite3InitModule()
  if (opts.file && 'storage' in navigator) {
    // On reload the previous page's worker can still hold the access handles for a moment,
    // so retry briefly before giving up on persistence.
    for (let attempt = 0; ; attempt++) {
      try {
        const pool = await sqlite3.installOpfsSAHPoolVfs(SAH_POOL)
        return { driver: wrap(new pool.OpfsSAHPoolDb(opts.file)), storage: 'opfs' }
      } catch (err) {
        if (attempt >= 8 || (err as Error).name !== 'NoModificationAllowedError') {
          console.warn('OPFS unavailable; using an in-memory replica', err)
          break
        }
        await new Promise((r) => setTimeout(r, 25 * 2 ** Math.min(attempt, 4)))
      }
    }
  }
  return { driver: wrap(new sqlite3.oo1.DB(':memory:')), storage: 'memory' }
}

function wrap(db: Database): SqlDriver {
  const cache = new Map<string, PreparedStatement>()
  const prepare = (sql: string) => {
    let stmt = cache.get(sql)
    if (!stmt) cache.set(sql, (stmt = db.prepare(sql)))
    return stmt
  }
  const bind = (stmt: PreparedStatement, params?: readonly SqlValue[]) => {
    stmt.reset(true)
    if (params?.length) stmt.bind(params)
  }
  return {
    run(sql, params) {
      const stmt = prepare(sql)
      bind(stmt, params)
      try {
        stmt.step()
      } finally {
        stmt.reset()
      }
    },
    all<T>(sql: string, params?: readonly SqlValue[]): T[] {
      const stmt = prepare(sql)
      bind(stmt, params)
      const rows: T[] = []
      try {
        while (stmt.step()) rows.push(stmt.get({}) as T)
      } finally {
        stmt.reset()
      }
      return rows
    },
    exec(sql) {
      db.exec(sql)
    },
    close() {
      for (const s of cache.values()) s.finalize()
      cache.clear()
      db.close()
    },
  }
}
