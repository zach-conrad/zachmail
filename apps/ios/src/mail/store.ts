/**
 * The iOS mail replica: the shared `SqlStore` (hub/local-store) on expo-sqlite, plus the
 * command layer. Triage verbs become shared ops (core `MailOp`): `enqueueOp` overlays the effect
 * on the replica in the same frame and persists it, and `OpDrain` sends it to /api/ops, or in the
 * demo settles it at once. Undo enqueues `invertOp` (design §3.1, architecture §1a, §6.5).
 * Reads are synchronous SQL; screens re-query when `version` changes.
 * No React Native imports, so tests run it on sqlite-wasm.
 */
import {
  invertOp,
  OpDrain,
  type AccountRow,
  type Address,
  type FolderKind,
  type MailOp,
  type MessageBody,
  type MessageRow,
  type Rows,
  type ThreadRow,
} from '@zachhub/core'
import {
  SqlStore,
  type SqlDriver,
  type SqlValue,
  type ThreadDetail,
  type ThreadListItem,
} from '@zachhub/local-store'
import type { SplitId } from './splits'

export type { ThreadListItem }
export type Scope = 'all' | string

export interface Draft {
  accountId: string
  to: string
  cc: string
  subject: string
  body: string
  /** Set when replying or forwarding. */
  threadId?: string
}

export interface Toast {
  id: number
  label: string
  /** Runs the inverse; absent for toasts without Undo. */
  undo?: () => void
}

/** What React subscribes to. `version` bumps on every replica write, so queries re-run. */
export interface MailState {
  version: number
  scope: Scope
  split: SplitId
  toast: Toast | null
  /** Sends waiting out the undo-send window. */
  pending: Record<number, Draft>
}

export type Command =
  | { kind: 'done'; threadId: string }
  | { kind: 'undone'; threadId: string }
  | { kind: 'trash'; threadId: string }
  | { kind: 'snooze'; threadId: string; until: number }
  | { kind: 'toggleRead'; threadId: string }
  | { kind: 'markRead'; threadId: string }
  | { kind: 'star'; threadId: string }

const TOAST_LABEL: Partial<Record<Command['kind'], string>> = {
  done: 'Marked done',
  undone: 'Moved to inbox',
  trash: 'Moved to trash',
  snooze: 'Reminder set',
}

export const UNDO_MS = 6_000
export const UNDO_SEND_MS = 10_000

// The replica doesn't keep `snoozedUntil`, so iOS remembers the snoozes it made, for the
// Reminders tab. The server owns the snooze itself; `SqlStore.reset()` never touches this table.
const IOS_SCHEMA = `CREATE TABLE IF NOT EXISTS ios_snoozes (thread_id TEXT PRIMARY KEY, until INTEGER);`

// Same shape `SqlStore.listThreads` returns, for the iOS-only lists (Done, Reminders, Search).
const ITEM = `json_object('id', t.id, 'accountId', t.account_id, 'subject', t.subject,
  'snippet', t.snippet, 'participants', json(t.participants), 'lastMessageAt', t.last_message_at,
  'messageCount', t.message_count, 'unread', json(iif(t.unread, 'true', 'false')),
  'starred', json(iif(t.starred, 'true', 'false')),
  'hasAttachments', json(iif(t.has_attachments, 'true', 'false')))`

type Listener = () => void

export class MailStore {
  readonly sql: SqlStore
  private state: MailState = {
    version: 0,
    scope: 'all',
    split: 'important',
    toast: null,
    pending: {},
  }
  private listeners = new Set<Listener>()
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private sendTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private seq = 0
  /** Sends queued ops. Settles them locally until sync points it at /api/ops. */
  private drain!: OpDrain

  constructor(
    private db: SqlDriver,
    private newId: () => string = () => globalThis.crypto.randomUUID(),
  ) {
    this.sql = new SqlStore(db)
    db.exec(IOS_SCHEMA)
    this.useDrain(null)
  }

  /** Send queued ops with `send` (POST /api/ops), or settle them locally when null (demo). */
  useDrain(send: OpSend | null) {
    this.drain = new OpDrain(
      {
        unsentOps: (n) => this.sql.unsentOps(n),
        markOpsSent: (ids) => this.sql.markOpsSent(ids),
        settleOps: (ids, keep) => {
          this.sql.settleOps(ids, keep)
          this.changed()
        },
      },
      {
        send,
        // The replica is already back to server state; just say so.
        onFailed: (rows) =>
          this.showToast(`Couldn't apply that change: ${rows[0]?.error ?? 'unknown error'}`),
      },
    )
    void this.drain.run()
  }

  /** Retry queued ops now (foreground, token refresh). */
  flushOps() {
    void this.drain.run()
  }

  getState = (): MailState => this.state

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<MailState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  /** Call after anything writes the replica (sync, body fetches) so screens re-query. */
  changed() {
    this.set({ version: this.state.version + 1 })
  }

  /** Load rows the way a sync batch would (demo seeding, tests). */
  seed(rows: Partial<Rows>, bodies: readonly MessageBody[] = [], seq = 0) {
    this.sql.apply(rows, null, seq)
    if (bodies.length) this.sql.putBodies(bodies)
    this.changed()
  }

  setScope(scope: Scope) {
    this.set({ scope })
  }

  setSplit(split: SplitId) {
    this.set({ split })
  }

  // ── Reads (pass the snapshot so React Compiler re-runs them when it changes) ─────────────────

  accounts(_s?: MailState): AccountRow[] {
    return this.sql.accounts()
  }

  account(id: string): AccountRow | undefined {
    return this.sql.accounts().find((a) => a.id === id)
  }

  inbox(s: MailState, limit = 500): ThreadListItem[] {
    return this.sql.listThreads({ split: s.split, accountId: scopeId(s) }, 0, limit)
  }

  /** Unread inbox threads per split, for the split switcher. */
  splitCounts(s: MailState): Record<SplitId, number> {
    const out: Record<SplitId, number> = {
      important: 0,
      other: 0,
      newsletters: 0,
      notifications: 0,
    }
    const [where, params] = scoped(s, 'unread = 1 AND split IS NOT NULL')
    for (const r of this.db.all<{ split: SplitId; n: number }>(
      `SELECT split, count(*) AS n FROM threads t WHERE ${where} GROUP BY split`,
      params,
    ))
      out[r.split] = r.n
    return out
  }

  /** Done = archived: out of the inbox, not trash/spam/drafts, not waiting on a reminder. */
  done(s: MailState, limit = 500): ThreadListItem[] {
    const [where, params] = scoped(
      s,
      `NOT EXISTS (SELECT 1 FROM json_each(t.folder_ids) j JOIN folders f ON f.id = j.value
         WHERE f.kind IN ('inbox', 'trash', 'spam', 'drafts'))
       AND t.id NOT IN (SELECT thread_id FROM ios_snoozes)`,
    )
    return this.items(
      `SELECT * FROM threads t WHERE ${where} ORDER BY last_message_at DESC, id DESC LIMIT ?`,
      [...params, limit],
    )
  }

  reminders(s: MailState): { thread: ThreadListItem; until: number }[] {
    const [where, params] = scoped(s, '1')
    return this.json<{ thread: ThreadListItem; until: number }[]>(
      `SELECT json_group_array(json_object('thread', json(item), 'until', until)) AS j FROM (
         SELECT ${ITEM} AS item, z.until FROM ios_snoozes z JOIN threads t ON t.id = z.thread_id
         WHERE ${where} ORDER BY z.until)`,
      params,
    )
  }

  /** Local search over subject, snippet and people (design §3.5); operators come with FTS. */
  search(s: MailState, query: string, limit = 200): ThreadListItem[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const like = terms
      .map(() => `lower(t.subject || ' ' || t.snippet || ' ' || t.participants) LIKE ? ESCAPE '\\'`)
      .join(' AND ')
    const params = terms.map((x) => `%${x.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    return this.items(
      `SELECT * FROM threads t WHERE ${like} ORDER BY last_message_at DESC LIMIT ?`,
      [...params, limit],
    )
  }

  thread(_s: MailState, id: string): ThreadDetail | null {
    return this.sql.getThread(id)
  }

  /** Position-ordered inbox ids, for auto-advance after triage in the reader. */
  nextInInbox(s: MailState, threadId: string): string | undefined {
    const q = { split: s.split, accountId: scopeId(s) }
    const i = this.sql.indexOfThread(q, threadId)
    return i < 0 ? undefined : this.sql.listThreads(q, i + 1, 1)[0]?.id
  }

  folderId(accountId: string, kind: FolderKind): string | undefined {
    return this.db.all<{ id: string }>(
      `SELECT id FROM folders WHERE account_id = ? AND kind = ? LIMIT 1`,
      [accountId, kind],
    )[0]?.id
  }

  // ── Commands ──────────────────────────────────────────────────────────────────────────────

  /** Apply a command to the replica; returns the inverse. Shows an Undo toast for list-removing verbs. */
  run(cmd: Command): () => void {
    const before = this.sql.getThread(cmd.threadId)?.thread
    const op = before && toOp(cmd, before)
    if (!op) return () => {}
    const prevSnooze = this.snoozeOf(cmd.threadId)
    this.enqueue(op)
    if (cmd.kind === 'snooze') this.setSnooze(cmd.threadId, cmd.until)
    else if (cmd.kind === 'done' || cmd.kind === 'trash' || cmd.kind === 'undone')
      this.setSnooze(cmd.threadId, undefined)
    this.changed()

    const undo = () => {
      this.enqueue(invertOp(op))
      this.setSnooze(cmd.threadId, prevSnooze)
      this.changed()
    }
    const label = TOAST_LABEL[cmd.kind]
    if (label) this.showToast(label, undo)
    return undo
  }

  private enqueue(op: MailOp) {
    this.sql.enqueueOp({ id: this.newId(), op, at: Date.now() })
    void this.drain.run()
  }

  /** undefined = not snoozed. */
  private snoozeOf(threadId: string): number | undefined {
    const r = this.db.all<{ until: number }>(`SELECT until FROM ios_snoozes WHERE thread_id = ?`, [
      threadId,
    ])[0]
    return r ? r.until : undefined
  }

  private setSnooze(threadId: string, until: number | undefined) {
    if (until === undefined) this.db.run(`DELETE FROM ios_snoozes WHERE thread_id = ?`, [threadId])
    else
      this.db.run(`INSERT OR REPLACE INTO ios_snoozes (thread_id, until) VALUES (?, ?)`, [
        threadId,
        until,
      ])
  }

  /**
   * Due reminders come back to the inbox (design §3.6). The server does this as well; sending
   * `unsnooze` from here too makes it instant and covers the demo. Call on foreground and each minute.
   */
  wake(now: number) {
    const due = this.db
      .all<{ thread_id: string }>(`SELECT thread_id FROM ios_snoozes WHERE until <= ?`, [now])
      .map((r) => r.thread_id)
    if (!due.length) return
    for (const id of due) this.setSnooze(id, undefined)
    const live = due.filter((id) => this.sql.getThread(id))
    if (live.length) this.enqueue({ kind: 'unsnooze', threadIds: live })
    this.changed()
  }

  // ── Toasts and sending ────────────────────────────────────────────────────────────────────

  showToast(label: string, undo?: () => void, ms = UNDO_MS) {
    clearTimeout(this.toastTimer)
    const id = ++this.seq
    this.set({ toast: { id, label, ...(undo ? { undo } : {}) } })
    this.toastTimer = setTimeout(() => this.dismissToast(id), ms)
  }

  dismissToast(id?: number) {
    if (!this.state.toast || (id !== undefined && this.state.toast.id !== id)) return
    clearTimeout(this.toastTimer)
    this.set({ toast: null })
  }

  /** Undo the toast's action, if any. */
  undoToast() {
    const t = this.state.toast
    if (!t?.undo) return
    this.dismissToast(t.id)
    t.undo()
  }

  /**
   * Queue a send behind the undo window (design §3.4). `onUndo` gets the draft back so the composer
   * can reopen it. The outbox (Phase 2 ops pipeline) takes the draft when the window closes.
   */
  send(draft: Draft, onUndo: (d: Draft) => void): number {
    const id = ++this.seq
    this.set({ pending: { ...this.state.pending, [id]: draft } })
    this.sendTimers.set(
      id,
      setTimeout(() => this.commitSend(id, Date.now()), UNDO_SEND_MS),
    )
    this.showToast(
      'Sending…',
      () => {
        const d = this.cancelSend(id)
        if (d) onUndo(d)
      },
      UNDO_SEND_MS,
    )
    return id
  }

  cancelSend(id: number): Draft | undefined {
    const d = this.state.pending[id]
    clearTimeout(this.sendTimers.get(id))
    this.sendTimers.delete(id)
    if (!d) return undefined
    const pending = { ...this.state.pending }
    delete pending[id]
    this.set({ pending })
    return d
  }

  /** Close the undo window: the sent message joins its thread (or starts one) in the replica. */
  commitSend(id: number, now: number) {
    const d = this.cancelSend(id)
    const acc = d && this.account(d.accountId)
    if (!d || !acc) return
    const threadId = d.threadId ?? `local-${now}-${id}`
    const from: Address = { name: acc.displayName ?? undefined, email: acc.email }
    const to = parseAddresses(d.to)
    const msg: MessageRow = {
      id: `${threadId}-sent-${now}-${id}`,
      threadId,
      accountId: acc.id,
      from,
      to,
      cc: parseAddresses(d.cc),
      replyTo: [],
      subject: d.subject,
      snippet: d.body.slice(0, 120),
      date: now,
      unread: false,
      starred: false,
      hasAttachments: false,
      listUnsubscribe: null,
      rfc822MessageId: null,
      bodyStatus: 'cached',
    }
    const sent = this.folderId(acc.id, 'sent')
    const prev = this.sql.getThread(threadId)?.thread
    const thread: ThreadRow = prev
      ? {
          ...prev,
          snippet: msg.snippet,
          lastMessageAt: now,
          messageCount: prev.messageCount + 1,
          folderIds:
            sent && !prev.folderIds.includes(sent) ? [...prev.folderIds, sent] : prev.folderIds,
        }
      : {
          id: threadId,
          accountId: acc.id,
          subject: d.subject,
          snippet: msg.snippet,
          participants: [from, ...to],
          lastMessageAt: now,
          messageCount: 1,
          unread: false,
          starred: false,
          hasAttachments: false,
          folderIds: sent ? [sent] : [],
        }
    this.sql.apply({ threads: [thread], messages: [msg] }, null, null)
    this.sql.putBodies([{ messageId: msg.id, html: textToHtml(d.body), hasRemoteImages: false }])
    this.changed()
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────

  private items(sql: string, params: SqlValue[]): ThreadListItem[] {
    return this.json<ThreadListItem[]>(
      `SELECT json_group_array(${ITEM}) AS j FROM (${sql}) t`,
      params,
    )
  }

  private json<T>(sql: string, params: readonly SqlValue[] = []): T {
    return JSON.parse(this.db.all<{ j: string | null }>(sql, params)[0]?.j ?? '[]') as T
  }
}

/** POST /api/ops (the sync transport's `ops`). */
export type OpSend = NonNullable<ConstructorParameters<typeof OpDrain>[1]['send']>

/** The shared op for a command, given the thread's current state (toggles need it). */
function toOp(cmd: Command, t: ThreadRow): MailOp | null {
  const threadIds = [cmd.threadId]
  switch (cmd.kind) {
    case 'done':
      return { kind: 'archive', threadIds }
    case 'undone':
      return { kind: 'inbox', threadIds }
    case 'trash':
      return { kind: 'trash', threadIds }
    case 'snooze':
      return { kind: 'snooze', threadIds, until: cmd.until }
    case 'toggleRead':
      return { kind: t.unread ? 'read' : 'unread', threadIds }
    case 'markRead':
      return t.unread ? { kind: 'read', threadIds } : null
    case 'star':
      return { kind: t.starred ? 'unstar' : 'star', threadIds }
  }
}

const scopeId = (s: MailState) => (s.scope === 'all' ? null : s.scope)

function scoped(s: MailState, where: string): [string, SqlValue[]] {
  const id = scopeId(s)
  return id ? [`(${where}) AND t.account_id = ?`, [id]] : [where, []]
}

export function parseAddresses(s: string): Address[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(.*)<([^>]+)>$/.exec(x)
      return m
        ? { name: m[1]!.trim().replace(/^"|"$/g, '') || undefined, email: m[2]!.trim() }
        : { email: x }
    })
}

export const textToHtml = (s: string) =>
  `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`
