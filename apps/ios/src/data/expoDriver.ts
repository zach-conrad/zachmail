import type { SqlDriver, SqlValue } from '@zachmail/local-store'
import { openDatabaseSync, type SQLiteBindValue, type SQLiteStatement } from 'expo-sqlite'

/**
 * `SqlDriver` over expo-sqlite's synchronous API (JSI), so the shared `SqlStore` runs on iOS
 * unchanged. Statements are prepared once and reused; a query is one native call.
 */
export function openExpoDriver(name: string): SqlDriver {
  const db = openDatabaseSync(name)
  db.execSync('PRAGMA journal_mode = WAL;')
  const cache = new Map<string, SQLiteStatement>()
  const prepare = (sql: string) => {
    let stmt = cache.get(sql)
    if (!stmt) cache.set(sql, (stmt = db.prepareSync(sql)))
    return stmt
  }
  const bind = (params?: readonly SqlValue[]) =>
    (params ?? []).map((p) => (typeof p === 'bigint' ? Number(p) : p)) as SQLiteBindValue[]
  return {
    run(sql, params) {
      prepare(sql).executeSync(bind(params)).resetSync()
    },
    all<T>(sql: string, params?: readonly SqlValue[]): T[] {
      const res = prepare(sql).executeSync<T>(bind(params))
      try {
        return res.getAllSync()
      } finally {
        res.resetSync()
      }
    },
    exec(sql) {
      db.execSync(sql)
    },
    close() {
      for (const s of cache.values()) s.finalizeSync()
      cache.clear()
      db.closeSync()
    },
  }
}
