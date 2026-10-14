export type SqlValue = string | number | bigint | null | Uint8Array

/**
 * The minimal synchronous SQLite surface the store needs. sqlite-wasm (web/macOS, inside a
 * worker) and expo-sqlite's sync API (iOS) both satisfy it, so the SQL lives in one place.
 */
export interface SqlDriver {
  /** Run one statement for its side effects. Implementations cache the prepared statement. */
  run(sql: string, params?: readonly SqlValue[]): void
  /** Run one query and return every row as an object keyed by column name. */
  all<T = Record<string, SqlValue>>(sql: string, params?: readonly SqlValue[]): T[]
  /** Run a script of several statements (schema, pragmas). */
  exec(sql: string): void
  close(): void
}
