import { ProviderFactory, createHandlers, engineConfigFromEnv } from '@zachmail/engine'
import { fromPostgresJs } from '@zachmail/db/server'
import type { Sql } from 'postgres'
import type { JobHandler } from './runner'

/** Job kinds the worker understands, backed by the shared engine. */
export function buildHandlers(sql: Sql): Record<string, JobHandler> {
  const db = fromPostgresJs(sql as never)
  const config = engineConfigFromEnv()
  return {
    ...createHandlers({ db, providers: new ProviderFactory(db, config), config }),
    noop: async () => {},
  }
}
