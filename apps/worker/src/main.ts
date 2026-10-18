import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { S3Client, backupConfigFromEnv, readBackupStatus, runNightlyBackup } from '@zachhub/backup'
import { fromPostgresJs } from '@zachhub/db/server'
import {
  Storage,
  engineConfigFromEnv,
  runWakeups,
  sweepOutbox,
  sweepSyncs,
  sweepUploads,
} from '@zachhub/engine'
import postgres from 'postgres'
import { buildHandlers } from './handlers'
import { pgQueue } from './queue'
import { Runner } from './runner'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) throw new Error('Missing env: DATABASE_URL')

const POLL_MS = 5_000
const workerId = process.env.FLY_MACHINE_ID ?? hostname()
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }))

// Session-mode connection: LISTEN needs a persistent connection (not the transaction pooler).
const sql = postgres(DATABASE_URL, { max: 5, idle_timeout: 0 })
const runner = new Runner({ workerId, queue: pgQueue(sql), handlers: buildHandlers(sql), log })

let lastTickOk = Date.now()
const tick = () =>
  runner.tick().then(
    () => (lastTickOk = Date.now()),
    (err) => log('tick failed', { error: String(err) }),
  )

await sql.listen('jobs', () => void tick())
const poll = setInterval(tick, POLL_MS)
const db = fromPostgresJs(sql as never)
const reap = setInterval(() => {
  sql`select reap_stale_jobs()`.catch((err) => log('reap failed', { error: String(err) }))
  sweepOutbox(db).catch((err) => log('outbox sweep failed', { error: String(err) }))
  // Safety net for lost wake jobs; the timed job is what makes a snooze return on the minute.
  runWakeups(db).catch((err) => log('wake sweep failed', { error: String(err) }))
}, 60_000)

// Slower housekeeping: safety-net syncs, stale-sync alerts, orphaned attachment uploads.
const storageConfig = engineConfigFromEnv().storage
const storage = storageConfig ? new Storage(storageConfig) : null
// Nightly offsite backup (hub/backup); off while BACKUP_S3_* is unset.
const backupConfig = backupConfigFromEnv()
const backupS3 = backupConfig ? new S3Client(backupConfig.s3) : null
if (!backupConfig) log('offsite backup is off (BACKUP_S3_* not set)')
const backup = async () => {
  if (!backupConfig || !backupS3) return
  try {
    const run = await runNightlyBackup(db, backupConfig, backupS3)
    if (run)
      log('backup uploaded', { key: run.key, bytes: run.bytes, rows: run.rows, pruned: run.pruned })
  } catch (err) {
    log('ALERT backup failed', { error: String(err) })
  }
  const { lastOk } = await readBackupStatus(db)
  // Failures alert above; this catches a job that silently stopped running.
  if (lastOk && Date.now() - Date.parse(lastOk.finishedAt ?? lastOk.startedAt) > 48 * 3_600_000)
    log('ALERT no good backup in 48h', { lastOk: lastOk.day })
}
const housekeep = async () => {
  await backup()
  for (const a of await sweepSyncs(db))
    log('ALERT stale sync', { accountId: a.id, status: a.status, lastSyncedAt: a.lastSyncedAt })
  if (storage) {
    const removed = await sweepUploads(db, storage)
    if (removed) log('removed orphaned uploads', { removed })
  }
}
const housekeeping = setInterval(
  () => void housekeep().catch((err) => log('housekeeping failed', { error: String(err) })),
  10 * 60_000,
)
void tick()

const health = createServer((req, res) => {
  const healthy = Date.now() - lastTickOk < POLL_MS * 6
  res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: healthy, workerId, busy: runner.busy }))
}).listen(Number(process.env.PORT ?? 8080))

log('worker started', { workerId })

async function shutdown(signal: string) {
  log('shutting down', { signal })
  clearInterval(poll)
  clearInterval(reap)
  clearInterval(housekeeping)
  health.close()
  await runner.tick().catch(() => {})
  await sql.end({ timeout: 10 })
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
