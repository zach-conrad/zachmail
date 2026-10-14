/// <reference lib="webworker" />
import {
  DEFAULT_UNDO_MS,
  OpDrain,
  SyncClient,
  httpTransport,
  startSyncLoop,
  type ContactRow,
  type MessageBody,
  type OpEnvelope,
  type OpsResponse,
  type SyncSink,
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
let enqueue: ((env: OpEnvelope) => void) | null = null
let drain = () => {}
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
    drain()
  } else if (m.type === 'nudge') {
    void sync?.pull()
    drain()
  } else if (!api || !enqueue) queue.push(m)
  else if (m.type === 'op') enqueue(m.env)
  else void call(m)
}

self.addEventListener('online', () => drain())

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
  // Demo mode has no server: ops are accepted on the spot and settle as if done.
  let sendOps: ((ops: OpEnvelope[]) => Promise<OpsResponse>) | null = null
  let outgoing: Pick<DataApi, 'send' | 'unsend' | 'saveDraft' | 'deleteDraft' | 'contacts'>
  if (config.mode === 'demo') {
    const fx = await import('./fixture')
    transport = fx.fixtureTransport(config.threads)
    fetchBody = async (id) => fx.fixtureBody(id)
    const sendAt = new Map<string, number>()
    outgoing = {
      async send(req) {
        const at = Math.max(Date.now() + (req.undoMs ?? DEFAULT_UNDO_MS), req.sendAt ?? 0)
        sendAt.set(req.id, at)
        return { id: req.id, sendAt: at }
      },
      unsend: async (id) => (sendAt.get(id) ?? 0) > Date.now(),
      saveDraft: async () => {},
      deleteDraft: async () => {},
      contacts: async () => fx.fixtureContacts(),
    }
  } else {
    // A 'token' message may have landed while SQLite was opening; it is the newer one.
    token ??= config.token
    const http = httpTransport({ baseUrl: config.apiBase, token: () => token })
    transport = http
    fetchBody = (id) => http.body(id)
    sendOps = (ops) => http.ops({ ops })
    let contacts: Promise<ContactRow[]> | null = null
    outgoing = {
      send: (req) => http.send(req),
      unsend: (id) => http.unsend(id),
      saveDraft: (id, d) => http.saveDraft(id, d),
      deleteDraft: (id) => http.deleteDraft(id),
      contacts: () =>
        (contacts ??= http.contacts().catch((err: unknown) => {
          contacts = null
          throw err
        })),
    }
  }

  const inflight = new Set<string>()
  api = {
    accounts: () => store.accounts(),
    countThreads: (q) => store.countThreads(q),
    unread: (q, since, limit) => store.unread(q, since, limit),
    listThreads: (q, offset, limit) => store.listThreads(q, offset, limit),
    indexOfThread: (q, id) => store.indexOfThread(q, id),
    folders: () => store.folders(),
    ...outgoing,
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
  enqueue = (env) => {
    store.enqueueOp(env)
    post({ type: 'changed' })
    drain()
  }

  const ops = new OpDrain(store, {
    send: sendOps,
    ready: () => config.mode === 'demo' || !!token,
    onFailed: (rows) => {
      for (const r of rows) post({ type: 'opFailed', id: r.id, error: r.error })
      post({ type: 'changed' })
    },
  })
  drain = () => void ops.run()

  for (const m of queue.splice(0)) {
    if (m.type === 'call') void call(m)
    else if (m.type === 'op') enqueue(m.env)
  }

  const sink: SyncSink = {
    getSeq: () => store.getSeq(),
    reset: () => store.reset(),
    apply(upserts, deletes, seq, ops = []) {
      store.apply(upserts, deletes, seq, ops)
      for (const o of ops)
        if (o.state === 'failed')
          post({ type: 'opFailed', id: o.id, error: o.error ?? 'The change could not be applied' })
    },
  }

  let lastError: string | null = null
  const client = new SyncClient(sink, transport, {
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
      drain()
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
