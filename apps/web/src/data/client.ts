import { markOnce } from '../lib/perf'
import type { OpEnvelope } from '@zachmail/core'
import type { DataApi, FromWorker, InitConfig, Method, ToWorker, WorkerStatus } from './protocol'

type Remote<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never
}

export type DataEvent = Extract<FromWorker, { type: 'changed' | 'bodies' | 'opFailed' }>

/** Main-thread handle on the data worker: typed RPC for reads, events for changes. */
export class DataClient {
  readonly api: Remote<DataApi>
  status: WorkerStatus = { storage: 'memory', syncing: false, error: null }
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Set<(e: DataEvent) => void>()
  private statusListeners = new Set<() => void>()
  private refs = 0
  private releaseTimer: ReturnType<typeof setTimeout> | undefined

  constructor(config: InitConfig) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'zachmail-data',
    })
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data)
    this.send({ type: 'init', config })
    const call =
      (method: Method) =>
      (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = this.nextId++
          this.pending.set(id, { resolve, reject })
          this.send({ type: 'call', id, method, args })
        })
    this.api = new Proxy({} as Remote<DataApi>, {
      get: (cache, method: Method) => ((cache as Record<string, unknown>)[method] ??= call(method)),
    })
  }

  setToken(token: string | null) {
    this.send({ type: 'token', token })
  }

  /** Hand an op the UI has already applied on screen to the worker's queue. */
  op(env: OpEnvelope) {
    this.send({ type: 'op', env })
  }

  /** Ask the worker to pull now (focus, Realtime nudge). */
  nudge() {
    this.send({ type: 'nudge' })
  }

  subscribe(fn: (e: DataEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  subscribeStatus = (fn: () => void): (() => void) => {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  getStatus = () => this.status

  /**
   * Reference-counted lifetime. Release terminates on the next tick unless retained again,
   * so StrictMode's mount → unmount → mount in dev keeps the same worker.
   */
  retain() {
    this.refs++
    clearTimeout(this.releaseTimer)
  }

  release() {
    if (--this.refs > 0) return
    this.releaseTimer = setTimeout(() => this.terminate(), 0)
  }

  terminate() {
    this.worker.terminate()
  }

  private send(m: ToWorker) {
    this.worker.postMessage(m)
  }

  private onMessage(m: FromWorker) {
    if (m.type === 'result') {
      const p = this.pending.get(m.id)
      this.pending.delete(m.id)
      if (m.ok) p?.resolve(m.value)
      else p?.reject(new Error(m.error))
    } else if (m.type === 'status') {
      if (this.status.syncing && !m.status.syncing && !m.status.error) markOnce('synced')
      this.status = m.status
      for (const fn of this.statusListeners) fn()
    } else {
      for (const fn of this.listeners) fn(m)
    }
  }
}
