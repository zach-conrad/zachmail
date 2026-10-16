import type {
  ContactRow,
  DraftRequest,
  OpEnvelope,
  SendRequest,
  SendResponse,
  SplitRuleRow,
} from '@zachhub/core'
import type { ListQuery, SearchListQuery, StoreApi, ThreadListItem } from '@zachhub/local-store'

/** Store reads the UI may call over the worker boundary (writes stay inside the worker). */
export type ReadMethod =
  'accounts' | 'folders' | 'getThread' | 'unread' | 'splitRules' | 'comingBack'

/** What a thread list shows: a split, or search results. */
export type ViewQuery = ListQuery | SearchListQuery

export interface RemoteSearchPage {
  /** Pass back for the next page; null when the server has nothing more. */
  cursor: string | null
  /** Results on this page (threads new to the replica are now in it). */
  found: number
  /** 'provider' once the server is reaching back into Gmail for older mail. */
  source: 'mirror' | 'provider'
}

export interface DataApi extends Pick<StoreApi, ReadMethod> {
  countThreads(q: ViewQuery): number
  listThreads(q: ViewQuery, offset: number, limit: number): ThreadListItem[]
  /** Position of a thread in a list, or -1 when it is not in it. */
  indexOfThread(q: ViewQuery, threadId: string): number
  /**
   * One page of server search (the mirror, then Gmail for older mail). Results join the
   * local results for `q`; a 'changed' event follows when the list should re-read.
   */
  searchRemote(q: SearchListQuery, cursor: string | null): Promise<RemoteSearchPage>
  /** Search is opening: pull its indexes into the page cache before the first keystroke. */
  warmSearch(): void
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
