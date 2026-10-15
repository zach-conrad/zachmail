import { ProviderFactory, createHandlers, engineConfigFromEnv } from '@zachhub/engine'
import { vapidFromEnv, webPushSender } from '@zachhub/engine/webpush'
import { fromPostgresJs } from '@zachhub/db/server'
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
