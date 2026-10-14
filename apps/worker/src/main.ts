import { createServer } from 'node:http'
import { hostname } from 'node:os'
import { fromPostgresJs } from '@zachmail/db/server'
import { runWakeups, sweepOutbox } from '@zachmail/engine'
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
  health.close()
  await runner.tick().catch(() => {})
  await sql.end({ timeout: 10 })
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
