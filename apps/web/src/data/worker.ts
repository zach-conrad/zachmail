/// <reference lib="webworker" />
import {
  SyncClient,
  httpTransport,
  startSyncLoop,
  type MessageBody,
  type SyncTransport,
} from '@zachmail/core'
import { SqlStore } from '@zachmail/local-store'
import { openSqliteWasm } from '@zachmail/local-store/sqlite-wasm'
import type { DataApi, FromWorker, InitConfig, ToWorker, WorkerStatus } from './protocol'

// SQLite, sync merges and body fetches all live here so the UI thread only renders.

declare const self: DedicatedWorkerGlobalScope

const post = (m: FromWorker) => self.postMessage(m)

let token: string | null = null
let sync: { pull(): Promise<void> } | null = null
let api: DataApi | null = null
const queue: ToWorker[] = []
const status: WorkerStatus = { storage: 'memory', syncing: false, error: null }
const setStatus = (s: Partial<WorkerStatus>) => {
  Object.assign(status, s)
  post({ type: 'status', status: { ...status } })
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'init') void init(m.config)
  else if (m.type === 'token') {
    const first = token === null && m.token !== null
    token = m.token
    if (first) void sync?.pull()
  } else if (m.type === 'nudge') void sync?.pull()
  else if (!api) queue.push(m)
  else void call(m)
}

async function call(m: Extract<ToWorker, { type: 'call' }>) {
  try {
    const fn = api![m.method] as (...a: unknown[]) => unknown
    post({ type: 'result', id: m.id, ok: true, value: await fn(...m.args) })
  } catch (err) {
    post({ type: 'result', id: m.id, ok: false, error: String(err) })
  }
}

async function init(config: InitConfig) {
  const { driver, storage } = await openSqliteWasm({
    file: config.mode === 'demo' ? '/demo.db' : '/zachmail.db',
  })
  const store = new SqlStore(driver)
  setStatus({ storage })

  let fetchBody: (id: string) => Promise<MessageBody>
  let transport: SyncTransport
  if (config.mode === 'demo') {
    const fx = await import('./fixture')
    transport = fx.fixtureTransport(config.threads)
    fetchBody = async (id) => fx.fixtureBody(id)
  } else {
    // A 'token' message may have landed while SQLite was opening; it is the newer one.
    token ??= config.token
    const http = httpTransport({ baseUrl: config.apiBase, token: () => token })
    transport = http
    fetchBody = (id) => http.body(id)
  }

  const inflight = new Set<string>()
  api = {
    accounts: () => store.accounts(),
    countThreads: (q) => store.countThreads(q),
    listThreads: (q, offset, limit) => store.listThreads(q, offset, limit),
    indexOfThread: (q, id) => store.indexOfThread(q, id),
    getThread: (id) => store.getThread(id),
    async ensureBodies(threadIds) {
      const missing = store.bodiesMissing(threadIds).filter((m) => !inflight.has(m.messageId))
      if (!missing.length) return 0
      const fetched: MessageBody[] = []
      const done = new Set<string>()
      const run = pool(missing, 6, async (m) => {
        try {
          fetched.push(await fetchBody(m.messageId))
          done.add(m.threadId)
        } catch (err) {
          console.warn('body fetch failed', m.messageId, err)
        }
      })
      for (const m of missing) inflight.add(m.messageId)
      try {
        await run
      } finally {
        for (const m of missing) inflight.delete(m.messageId)
      }
      if (fetched.length) {
        store.putBodies(fetched)
        post({ type: 'bodies', threadIds: [...done] })
      }
      return fetched.length
    },
  }
  for (const m of queue.splice(0)) if (m.type === 'call') void call(m)

  let lastError: string | null = null
  const client = new SyncClient(store, transport, {
    onChange: () => post({ type: 'changed' }),
    onError: (err) => (lastError = String(err)),
  })
  sync = {
    async pull() {
      // A live session without a token yet waits for the 'token' message.
      if (config.mode === 'live' && !token) return
      lastError = null
      setStatus({ syncing: true })
      await client.pull()
      setStatus({ syncing: false, error: lastError })
    },
  }
  startSyncLoop(sync)
}

/** Runs `fn` over `items` with at most `n` in flight. */
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0
  const next = async (): Promise<void> => {
    while (i < items.length) await fn(items[i++]!)
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, next))
}
