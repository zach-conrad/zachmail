/**
 * The minimal SQL surface server code needs. Keeping it this small lets the same queries run
 * on postgres.js in production and PGlite in tests.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
}

interface PostgresJsLike {
  unsafe(text: string, params?: unknown[]): Promise<unknown>
  begin<T>(fn: (tx: PostgresJsLike) => Promise<T>): Promise<T>
}

/** Adapts a postgres.js `sql` instance. */
export function fromPostgresJs(sql: PostgresJsLike): Db {
  const wrap = (s: PostgresJsLike): Queryable => ({
    query: async <T>(text: string, params: unknown[] = []) => [
      ...((await s.unsafe(text, params as never[])) as T[]),
    ],
  })
  return {
    ...wrap(sql),
    transaction: (fn) => sql.begin((tx) => fn(wrap(tx))) as never,
  }
}

interface PGliteLike {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>
  transaction<T>(
    fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>,
  ): Promise<T>
}

/** Adapts a PGlite instance (tests). */
export function fromPGlite(db: PGliteLike): Db {
  return {
    query: async (text, params) => (await db.query(text, params)).rows as never,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({ query: async (text, params) => (await tx.query(text, params)).rows as never }),
      ),
  }
}
