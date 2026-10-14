import type { OpEnvelope, SplitRuleRow } from '@zachmail/core'
import type { StoreApi } from '@zachmail/local-store'

/** Store reads the UI may call over the worker boundary (writes stay inside the worker). */
export type ReadMethod =
  | 'accounts'
  | 'folders'
  | 'countThreads'
  | 'listThreads'
  | 'indexOfThread'
  | 'getThread'
  | 'unread'
  | 'splitRules'

export interface DataApi extends Pick<StoreApi, ReadMethod> {
  /** Fetch and cache the bodies a thread view needs; resolves once they are stored. */
  ensureBodies(threadIds: string[]): Promise<number>
}

export type Method = keyof DataApi

export type InitConfig =
  { mode: 'live'; apiBase: string; token: string | null } | { mode: 'demo'; threads: number }

export type ToWorker =
  | { type: 'init'; config: InitConfig }
  | { type: 'token'; token: string | null }
  | { type: 'nudge' }
  /** A triage op the UI already applied on screen: persist, overlay and send it. */
  | { type: 'op'; env: OpEnvelope }
  /** Save (rule) or delete (null) a split rule: re-split locally now, send when online. */
  | { type: 'splitRule'; id: string; rule: SplitRuleRow | null }
  | { type: 'call'; id: number; method: Method; args: unknown[] }

export interface WorkerStatus {
  storage: 'opfs' | 'memory'
  syncing: boolean
  error: string | null
}

export type FromWorker =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  /** Synced rows changed: re-read lists and open threads. */
  | { type: 'changed' }
  /** Bodies for these threads were stored. */
  | { type: 'bodies'; threadIds: string[] }
  | { type: 'status'; status: WorkerStatus }
  /** The server refused or could not apply an op; its threads are back to server state. */
  | { type: 'opFailed'; id: string; error: string }
