import { ProviderFactory, createHandlers, engineConfigFromEnv, notify } from '@zachhub/engine'
import { vapidFromEnv, webPushSender } from '@zachhub/engine/webpush'
import { fromPostgresJs } from '@zachhub/db/server'
import { installed } from '@zachhub/modules'
import type { Sql } from 'postgres'
import type { JobHandler } from './runner'

/** Job kinds the worker understands, backed by the shared engine. */
export function buildHandlers(sql: Sql): Record<string, JobHandler> {
  const db = fromPostgresJs(sql as never)
  const config = engineConfigFromEnv()
  const vapid = vapidFromEnv()
  const push = vapid ? webPushSender(vapid) : undefined
  return {
    ...createHandlers({ db, providers: new ProviderFactory(db, config), config, push }),
    // Module job kinds are namespaced ('tasks.alert'), so they can't shadow the engine's.
    ...installed.jobs({
      db,
      // Without VAPID keys nothing can be pushed; notices are dropped like mail's.
      notify: async (userId, notice) => (push ? notify(db, push, userId, notice) : 0),
    }),
    noop: async () => {},
  }
}
