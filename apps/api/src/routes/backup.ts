import { Readable } from 'node:stream'
import { Hono } from 'hono'
import type { AuthVariables } from '../auth'
import type { Deps } from '../deps'

/**
 * Settings → Export everything, and the nightly backup's status. The export is the same
 * gzipped NDJSON the nightly job uploads, so `pnpm --filter @zachhub/backup restore --file`
 * takes either. The backup module loads on first use to stay out of every cold start.
 */
export function backupRoutes(deps: Deps) {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get('/export', async (c) => {
    const { backupStream } = await import('@zachhub/backup')
    const day = new Date().toISOString().slice(0, 10)
    const body = Readable.toWeb(backupStream(deps.db(), { userId: c.get('user').id }))
    return c.body(body as ReadableStream, 200, {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="zachhub-export-${day}.ndjson.gz"`,
      'cache-control': 'no-store',
    })
  })

  app.get('/backup/status', async (c) => {
    const { readBackupStatus } = await import('@zachhub/backup')
    return c.json(await readBackupStatus(deps.db()))
  })

  return app
}
