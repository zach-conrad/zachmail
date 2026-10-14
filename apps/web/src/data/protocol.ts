import type {
  ContactRow,
  DraftRequest,
  OpEnvelope,
  SendRequest,
  SendResponse,
  SnippetRow,
  SplitRuleRow,
} from '@zachmail/core'
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
  | 'snippets'
  | 'followUps'

export interface DataApi extends Pick<StoreApi, ReadMethod> {
  /** Fetch and cache the bodies a thread view needs; resolves once they are stored. */
  ensureBodies(threadIds: string[]): Promise<number>
  /** Queue a message on the server; it goes out after the undo window. */
  send(req: SendRequest): Promise<SendResponse>
  /** Undo send: true when cancelled in time, false when it already went. */
  unsend(id: string): Promise<boolean>
  saveDraft(id: string, draft: DraftRequest): Promise<void>
  deleteDraft(id: string): Promise<void>
  /** Everyone Zach writes to or hears from, best first (cached after the first call). */
  contacts(): Promise<ContactRow[]>
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
  /** Save (snippet) or delete (null) a snippet: local now, sent when online. */
  | { type: 'snippet'; id: string; snippet: SnippetRow | null }
  /** Hide (dismiss) or bring back follow-up nudges on these threads. */
  | { type: 'nudges'; threadIds: string[]; dismiss: boolean }
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
