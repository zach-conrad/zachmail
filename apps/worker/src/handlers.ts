import { ProviderFactory, createHandlers, engineConfigFromEnv } from '@zachmail/engine'
import { vapidFromEnv, webPushSender } from '@zachmail/engine/webpush'
import { fromPostgresJs } from '@zachmail/db/server'
import type { Sql } from 'postgres'
import type { JobHandler } from './runner'

/** Job kinds the worker understands, backed by the shared engine. */
export function buildHandlers(sql: Sql): Record<string, JobHandler> {
  const db = fromPostgresJs(sql as never)
  const config = engineConfigFromEnv()
  const vapid = vapidFromEnv()
  return {
    ...createHandlers({
      db,
      providers: new ProviderFactory(db, config),
      config,
      push: vapid ? webPushSender(vapid) : undefined,
    }),
    noop: async () => {},
  }
}
