import {
  applyEffect,
  DEFAULT_NUDGE_AFTER_MS,
  DEFAULT_NUDGE_WINDOW_MS,
  compileSplitRules,
  followUpNudge,
  type ComposerEdit,
  inboundSender,
  opEffect,
  type AccountRow,
  type Address,
  type Deletes,
  type FolderKind,
  type FolderRow,
  type FollowUpNudge,
  type MessageBody,
  type MessageRow,
  type NudgeDismissalRow,
  type NudgeOptions,
  type OpEnvelope,
  type OpStatusRow,
  type Rows,
  type CompiledSplitRules,
  type SnippetRow,
  type SplitKey,
  type SplitRuleRow,
  type SyncSink,
  type ThreadRow,
} from '@zachhub/core'
import type { SqlDriver, SqlValue } from './driver'
import { DROP_ALL, SCHEMA, SCHEMA_VERSION } from './schema'
import { EditableTable } from './editable'
import { SplitRuleTable, type PendingSplitRule } from './splitRules'

/** One row of the inbox list: only what ThreadRow renders. */
export interface ThreadListItem {
  id: string
  accountId: string
  subject: string
  snippet: string
  participants: Address[]
  lastMessageAt: number
  messageCount: number
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  folderIds: string[]
}

export interface ListQuery {
  /** A built-in split id or a custom split rule id. */
  split: SplitKey
  /** Account scope; null or absent means all accounts. */
  accountId?: string | null
}

/** A follow-up nudge with the row the list renders. */
export interface FollowUpItem extends FollowUpNudge {
  thread: ThreadListItem
}

export interface ThreadDetail {
  thread: ThreadRow
  /** Oldest first. */
  messages: MessageRow[]
  /** Cached bodies by message id; a message without one is fetched on demand. */
  bodies: Record<string, MessageBody>
}

/**
 * Everything the app reads from or writes to the local replica. The web app calls it over
 * postMessage (each method becomes async); iOS can call it directly.
 */
export interface StoreApi extends SyncSink {
  getSeq(): number | null
  reset(): void
  apply(
    upserts: Partial<Rows>,
    deletes: Partial<Deletes> | null,
    seq: number | null,
    ops?: readonly OpStatusRow[],
  ): void
  accounts(): AccountRow[]
  folders(): FolderRow[]
  countThreads(q: ListQuery): number
  /** Unread threads in a view, and the newest few that arrived after `since` (epoch ms). */
  unread(q: ListQuery, since: number, limit: number): { count: number; fresh: ThreadListItem[] }
  listThreads(q: ListQuery, offset: number, limit: number): ThreadListItem[]
  /** Position of a thread in a list, or -1 when it is not in it. */
  indexOfThread(q: ListQuery, threadId: string): number
  getThread(threadId: string): ThreadDetail | null
  /** Of the messages a thread view expands on open (latest + unread), those without a body. */
  bodiesMissing(threadIds: readonly string[]): { messageId: string; threadId: string }[]
  putBodies(bodies: readonly MessageBody[]): void

  // ---- Triage ops (architecture §6.4) ----------------------------------------------------
  /** Applies an op to the replica now and queues it for the server. */
  enqueueOp(env: OpEnvelope): void
  /** Queued ops the server has not accepted yet, oldest first. */
  unsentOps(limit: number): OpEnvelope[]
  /** The server accepted these; they stay overlaid until a delta settles them. */
  markOpsSent(ids: readonly string[]): void
  /**
   * Forgets ops and re-derives their threads from server state, which already carries a done
   * op and has been restored after a failed one. `keep` instead folds their effect into the
   * server state, for a replica with no server behind it (demo mode).
   */
  settleOps(ids: readonly string[], keep?: boolean): void

  // ---- Split rules ------------------------------------------------------------------------
  /** Rules as the user sees them: synced rows with unsent local edits on top. */
  splitRules(): SplitRuleRow[]
  /** Saves (rule) or deletes (null) a rule locally and re-splits the inbox now. */
  editSplitRule(id: string, rule: SplitRuleRow | null): void
  /** Local rule edits the server has not accepted yet, oldest first. */
  pendingSplitRules(): PendingSplitRule[]
  ackSplitRule(sent: PendingSplitRule): void
  rejectSplitRule(id: string): void
  /**
   * A rules change re-splits in steps: threads still to move, and one step that moves up to
   * `max` of them. Run steps until 0, yielding between them.
   */
  resplitPending(): number
  resplitStep(max?: number): number

  // ---- Snippets and follow-up nudges ------------------------------------------------------
  /** Snippets with unsent local edits on top, by name. */
  snippets(): SnippetRow[]
  /** Saves (snippet) or deletes (null) a snippet locally. */
  editSnippet(id: string, snippet: SnippetRow | null): void
  /** Hides (dismiss) or brings back the nudges on these threads, locally first. */
  dismissNudges(threadIds: readonly string[], dismiss: boolean): void
  /** Due follow-up nudges at `now`, most recently due first, at most `limit`. */
  followUps(now: number, opts?: NudgeOptions, limit?: number): FollowUpItem[]
  /** Local snippet and dismissal edits the server has not accepted yet, oldest first. */
  composerEdits(): ComposerEdit[]
  ackComposerEdit(sent: ComposerEdit): void
  rejectComposerEdit(sent: ComposerEdit): void
}

/** The fields of a thread that ops change; `srv` holds the server's copy while overlaid. */
interface Overlayable {
  folderIds: string[]
  unread: boolean
  starred: boolean
}

interface QueuedOp {
  env: OpEnvelope
  threads: Set<string>
  sent: boolean
}

const CHUNK = 400 // stays well under SQLite's bound-parameter limit

interface ThreadSqlRow {
  id: string
  account_id: string
  subject: string
  snippet: string
  participants: string
  last_message_at: number
  message_count: number
  unread: number
  starred: number
  has_attachments: number
  folder_ids: string
}

export class SqlStore implements StoreApi {
  private folderKind = new Map<string, FolderKind>()
  private accountsWithImportant = new Set<string>()
  private ownEmails = new Set<string>()
  private folderOf = new Map<string, Map<FolderKind, string>>()
  private ops: QueuedOp[] = []
  private rules: SplitRuleTable
  private snippetRows: EditableTable<SnippetRow>
  private dismissals: EditableTable<NudgeDismissalRow>
  private compiled: CompiledSplitRules = compileSplitRules([])
  /** Threads a rules change moves, written a chunk at a time by `resplitStep`. */
  private resplitIds: string[] = []

  constructor(private db: SqlDriver) {
    db.exec('PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -64000;')
    db.exec(SCHEMA)
    const v = db.all<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema'`)[0]
    if (v && Number(v.value) !== SCHEMA_VERSION) {
      db.exec(DROP_ALL)
      db.exec(SCHEMA)
    }
    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`, [
      String(SCHEMA_VERSION),
    ])
    this.rules = new SplitRuleTable(db)
    this.snippetRows = new EditableTable(db, 'snippets')
    this.dismissals = new EditableTable(db, 'nudge_dismissals')
    this.loadLookups()
    this.ops = this.db
      .all<{ envelope: string; sent: number }>(
        `SELECT envelope, sent FROM pending_ops ORDER BY seq`,
      )
      .map((r) => queued(JSON.parse(r.envelope) as OpEnvelope, !!r.sent))
  }

  // ---- Sync sink -------------------------------------------------------------------------

  getSeq(): number | null {
    const r = this.db.all<{ value: string }>(`SELECT value FROM meta WHERE key = 'seq'`)[0]
    return r ? Number(r.value) : null
  }

  reset(): void {
    this.tx(() => {
      for (const t of ['accounts', 'folders', 'threads', 'messages', 'bodies'])
        this.db.run(`DELETE FROM ${t}`)
      this.db.run(`DELETE FROM meta WHERE key = 'seq'`)
      // The server already holds accepted ops, so the snapshot carries them. Unsent ones stay
      // queued and re-apply as their threads arrive.
      this.db.run(`DELETE FROM pending_ops WHERE sent = 1`)
      // The snapshot resends every rule; unsent local edits stay on top.
      this.rules.clearSynced()
      this.snippetRows.clearSynced()
      this.dismissals.clearSynced()
    })
    this.ops = this.ops.filter((o) => !o.sent)
    this.loadLookups()
  }

  apply(
    upserts: Partial<Rows>,
    deletes: Partial<Deletes> | null,
    seq: number | null,
    ops: readonly OpStatusRow[] = [],
  ): void {
    this.tx(() => {
      const touched = new Set<string>()
      let lookupsChanged = false
      // Rows go in as one JSON array per table and SQLite unpacks them in C: an order of
      // magnitude faster than binding parameters row by row through wasm.
      if (upserts.accounts?.length) {
        this.db.run(
          `INSERT OR REPLACE INTO accounts (id, data)
           SELECT value ->> 'id', json(value) FROM jsonb_each(?)`,
          [JSON.stringify(upserts.accounts)],
        )
        lookupsChanged = true
      }
      if (upserts.folders?.length) {
        lookupsChanged ||= upserts.folders.some((f) => this.folderKind.get(f.id) !== f.kind)
        this.db.run(
          `INSERT OR REPLACE INTO folders (id, account_id, kind, data)
           SELECT value ->> 'id', value ->> 'accountId', value ->> 'kind', json(value)
           FROM jsonb_each(?)`,
          [JSON.stringify(upserts.folders)],
        )
      }
      if (upserts.threads?.length) {
        this.db.run(
          `INSERT OR REPLACE INTO threads (id, account_id, subject, snippet, participants,
             last_message_at, message_count, unread, starred, has_attachments, folder_ids)
           SELECT value ->> 'id', value ->> 'accountId', value ->> 'subject',
             value ->> 'snippet', json(value -> 'participants'), value ->> 'lastMessageAt',
             value ->> 'messageCount', value ->> 'unread', value ->> 'starred',
             value ->> 'hasAttachments', json(value -> 'folderIds')
           FROM jsonb_each(?)`,
          [JSON.stringify(upserts.threads)],
        )
        for (const t of upserts.threads) touched.add(t.id)
      }
      if (upserts.messages?.length) {
        this.db.run(
          `INSERT OR REPLACE INTO messages (id, thread_id, date, unread, list_unsubscribe,
             from_email, data)
           SELECT value ->> 'id', value ->> 'threadId', value ->> 'date', value ->> 'unread',
             value ->> 'listUnsubscribe' IS NOT NULL, lower(value ->> '$.from.email'), json(value)
           FROM jsonb_each(?)`,
          [JSON.stringify(upserts.messages)],
        )
        for (const m of upserts.messages) touched.add(m.threadId)
      }
      if (deletes) {
        this.deleteIds('accounts', 'id', deletes.account)
        this.deleteIds('folders', 'id', deletes.folder)
        for (const ids of chunks(deletes.message ?? []))
          for (const r of this.db.all<{ thread_id: string }>(
            `SELECT DISTINCT thread_id FROM messages WHERE id IN (${marks(ids.length)})`,
            ids,
          ))
            touched.add(r.thread_id)
        this.deleteIds('bodies', 'message_id', deletes.message)
        this.deleteIds('messages', 'id', deletes.message)
        if (deletes.thread?.length) {
          for (const ids of chunks(deletes.thread)) {
            const q = marks(ids.length)
            this.db.run(
              `DELETE FROM bodies WHERE message_id IN (SELECT id FROM messages WHERE thread_id IN (${q}))`,
              ids,
            )
            this.db.run(`DELETE FROM messages WHERE thread_id IN (${q})`, ids)
            this.db.run(`DELETE FROM threads WHERE id IN (${q})`, ids)
          }
        }
        lookupsChanged ||= !!deletes.account?.length || !!deletes.folder?.length
      }
      // A synced rule change re-splits only when what the user sees changed: the server
      // echoing a local edit back is a no-op.
      let rulesChanged = false
      if (this.rules.applySynced(upserts.splitRules, deletes?.splitRule ?? [])) {
        const before = JSON.stringify(this.compiled.rules)
        this.compiled = compileSplitRules(this.rules.effective())
        rulesChanged = JSON.stringify(this.compiled.rules) !== before
      }
      this.snippetRows.applySynced(upserts.snippets, deletes?.snippet ?? [])
      this.dismissals.applySynced(upserts.nudgeDismissals, deletes?.nudgeDismissal ?? [])
      if (lookupsChanged) this.loadLookups()
      // Fresh server rows replaced any overlay; put pending ops back on top of them.
      if (this.ops.length && upserts.threads?.length) {
        const queuedOn = new Set(this.ops.flatMap((o) => [...o.threads]))
        this.rebase(upserts.threads.map((t) => t.id).filter((id) => queuedOn.has(id)))
      }
      const settled = ops.filter((o) => o.state !== 'pending').map((o) => o.id)
      if (settled.length) for (const id of this.settle(settled, false)) touched.add(id)
      if (lookupsChanged) {
        this.classify(null)
      } else {
        if (rulesChanged) this.queueResplit()
        if (touched.size) this.classify([...touched])
      }
      if (seq !== null)
        this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)`, [String(seq)])
    })
  }

  // ---- Reads -----------------------------------------------------------------------------

  accounts(): AccountRow[] {
    return this.db
      .all<{ data: string }>(`SELECT data FROM accounts ORDER BY rowid`)
      .map((r) => JSON.parse(r.data) as AccountRow)
  }

  folders(): FolderRow[] {
    return this.json<FolderRow[]>(
      `SELECT json_group_array(json(data)) AS j FROM (SELECT data FROM folders ORDER BY rowid)`,
    )
  }

  countThreads(q: ListQuery): number {
    const [where, params] = listWhere(q)
    return this.db.all<{ n: number }>(
      `SELECT count(*) AS n FROM threads WHERE ${where}`,
      params,
    )[0]!.n
  }

  unread(q: ListQuery, since: number, limit: number) {
    const [where, params] = listWhere(q)
    const count = this.db.all<{ n: number }>(
      `SELECT count(*) AS n FROM threads WHERE ${where} AND unread = 1`,
      params,
    )[0]!.n
    const fresh = this.json<ThreadListItem[]>(
      `SELECT json_group_array(json_object('id', id, 'accountId', account_id,
         'subject', subject, 'snippet', snippet, 'participants', json(participants),
         'lastMessageAt', last_message_at, 'messageCount', message_count,
         'unread', json('true'), 'starred', json(iif(starred, 'true', 'false')),
         'hasAttachments', json(iif(has_attachments, 'true', 'false')),
         'folderIds', json(folder_ids))) AS j
       FROM (SELECT * FROM threads WHERE ${where} AND unread = 1 AND last_message_at > ?
             ORDER BY last_message_at DESC, id DESC LIMIT ?)`,
      [...params, since, limit],
    )
    return { count, fresh }
  }

  listThreads(q: ListQuery, offset: number, limit: number): ThreadListItem[] {
    const [where, params] = listWhere(q)
    return this.json<ThreadListItem[]>(
      `SELECT json_group_array(json_object('id', id, 'accountId', account_id,
         'subject', subject, 'snippet', snippet, 'participants', json(participants),
         'lastMessageAt', last_message_at, 'messageCount', message_count,
         'unread', json(iif(unread, 'true', 'false')),
         'starred', json(iif(starred, 'true', 'false')),
         'hasAttachments', json(iif(has_attachments, 'true', 'false')),
         'folderIds', json(folder_ids))) AS j
       FROM (SELECT * FROM threads WHERE ${where}
             ORDER BY last_message_at DESC, id DESC LIMIT ? OFFSET ?)`,
      [...params, limit, offset],
    )
  }

  indexOfThread(q: ListQuery, threadId: string): number {
    const t = this.db.all<{ last_message_at: number; split: string | null; account_id: string }>(
      `SELECT last_message_at, split, account_id FROM threads WHERE id = ?`,
      [threadId],
    )[0]
    if (!t || t.split !== q.split || (q.accountId && t.account_id !== q.accountId)) return -1
    const [where, params] = listWhere(q)
    return this.db.all<{ n: number }>(
      `SELECT count(*) AS n FROM threads WHERE ${where}
         AND (last_message_at > ? OR (last_message_at = ? AND id > ?))`,
      [...params, t.last_message_at, t.last_message_at, threadId],
    )[0]!.n
  }

  getThread(threadId: string): ThreadDetail | null {
    const t = this.db.all<ThreadSqlRow>(`SELECT * FROM threads WHERE id = ?`, [threadId])[0]
    if (!t) return null
    const messages = this.json<MessageRow[]>(
      `SELECT json_group_array(json(data)) AS j
       FROM (SELECT data FROM messages WHERE thread_id = ? ORDER BY date, id)`,
      [threadId],
    )
    const bodies: Record<string, MessageBody> = {}
    for (const ids of chunks(messages.map((m) => m.id))) {
      for (const b of this.db.all<{ message_id: string; html: string; has_remote_images: number }>(
        `SELECT message_id, html, has_remote_images FROM bodies WHERE message_id IN (${marks(ids.length)})`,
        ids,
      ))
        bodies[b.message_id] = {
          messageId: b.message_id,
          html: b.html,
          hasRemoteImages: !!b.has_remote_images,
        }
    }
    return {
      thread: toListItem(t),
      messages,
      bodies,
    }
  }

  bodiesMissing(threadIds: readonly string[]): { messageId: string; threadId: string }[] {
    const out: { messageId: string; threadId: string }[] = []
    for (const ids of chunks(threadIds)) {
      // Latest message of each thread, plus every unread one: what the reader expands.
      const rows = this.db.all<{ messageId: string; threadId: string }>(
        `SELECT m.id AS messageId, m.thread_id AS threadId FROM messages m
         WHERE m.thread_id IN (${marks(ids.length)})
           AND (m.unread = 1 OR m.id = (
             SELECT id FROM messages l WHERE l.thread_id = m.thread_id
             ORDER BY l.date DESC, l.id DESC LIMIT 1))
           AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)`,
        ids,
      )
      out.push(...rows)
    }
    return out
  }

  putBodies(bodies: readonly MessageBody[]): void {
    const now = Date.now()
    this.tx(() => {
      for (const b of bodies)
        this.db.run(
          `INSERT OR REPLACE INTO bodies (message_id, html, has_remote_images, fetched_at)
           VALUES (?, ?, ?, ?)`,
          [b.messageId, b.html, +b.hasRemoteImages, now],
        )
    })
  }

  // ---- Triage ops ------------------------------------------------------------------------

  enqueueOp(env: OpEnvelope): void {
    this.tx(() => {
      this.db.run(`INSERT OR IGNORE INTO pending_ops (id, envelope) VALUES (?, ?)`, [
        env.id,
        JSON.stringify(env),
      ])
      if (this.ops.some((o) => o.env.id === env.id)) return
      this.ops.push(queued(env, false))
      this.rebase(env.op.threadIds)
      this.classify(env.op.threadIds)
    })
  }

  unsentOps(limit: number): OpEnvelope[] {
    return this.ops
      .filter((o) => !o.sent)
      .slice(0, limit)
      .map((o) => o.env)
  }

  markOpsSent(ids: readonly string[]): void {
    const set = new Set(ids)
    for (const o of this.ops) if (set.has(o.env.id)) o.sent = true
    for (const c of chunks(ids))
      this.db.run(`UPDATE pending_ops SET sent = 1 WHERE id IN (${marks(c.length)})`, c)
  }

  settleOps(ids: readonly string[], keep = false): void {
    this.tx(() => this.classify(this.settle(ids, keep)))
  }

  close(): void {
    this.db.close()
  }

  // ---- Internals -------------------------------------------------------------------------

  private tx(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private deleteIds(table: string, col: string, ids: readonly string[] | undefined) {
    for (const c of chunks(ids ?? []))
      this.db.run(`DELETE FROM ${table} WHERE ${col} IN (${marks(c.length)})`, c)
  }

  /** Drops ops and re-derives their threads; returns the threads touched. */
  private settle(ids: readonly string[], keep: boolean): string[] {
    const set = new Set(ids)
    const gone = this.ops.filter((o) => set.has(o.env.id))
    if (!gone.length) return []
    this.ops = this.ops.filter((o) => !set.has(o.env.id))
    for (const c of chunks(ids))
      this.db.run(`DELETE FROM pending_ops WHERE id IN (${marks(c.length)})`, c)
    const threads = [...new Set(gone.flatMap((o) => [...o.threads]))]
    this.rebase(threads, keep ? gone : [])
    return threads
  }

  /**
   * Recomputes threads as server state (with `fold` merged into it) plus every queued op that
   * touches them, in order. Rows with nothing queued drop their overlay. Does not reclassify.
   */
  private rebase(threadIds: readonly string[], fold: readonly QueuedOp[] = []) {
    type Row = [id: string, accountId: string, f: string[], u: number, s: number, srv: Overlayable]
    const rows = chunks([...new Set(threadIds)]).flatMap((ids) =>
      this.json<Row[]>(
        `SELECT json_group_array(json_array(id, account_id, json(folder_ids), unread, starred,
           json(srv))) AS j FROM threads WHERE id IN (${marks(ids.length)})`,
        ids,
      ),
    )
    const out: [string, string, number, number, string | null][] = []
    for (const [id, accountId, f, u, s, srv] of rows) {
      const kinds = this.folderOf.get(accountId)
      const effect = (o: QueuedOp) => opEffect(o.env.op, (k) => kinds?.get(k))
      const step = (t: Overlayable, o: QueuedOp) =>
        o.threads.has(id) ? applyEffect(t as Overlayable & ThreadRow, effect(o)) : t
      const server = fold.reduce(step, srv ?? { folderIds: f, unread: !!u, starred: !!s })
      const mine = this.ops.filter((o) => o.threads.has(id))
      const now = mine.reduce(step, server)
      out.push([
        id,
        JSON.stringify(now.folderIds),
        +now.unread,
        +now.starred,
        mine.length ? JSON.stringify(pick(server)) : null,
      ])
    }
    if (out.length)
      this.db.run(
        `UPDATE threads SET folder_ids = c.value ->> 1, unread = c.value ->> 2,
           starred = c.value ->> 3, srv = c.value ->> 4
         FROM jsonb_each(?) AS c WHERE threads.id = c.value ->> 0`,
        [JSON.stringify(out)],
      )
  }

  private loadLookups() {
    this.folderKind.clear()
    this.folderOf.clear()
    this.accountsWithImportant.clear()
    for (const f of this.db.all<{ id: string; account_id: string; kind: FolderKind }>(
      `SELECT id, account_id, kind FROM folders`,
    )) {
      this.folderKind.set(f.id, f.kind)
      let byKind = this.folderOf.get(f.account_id)
      if (!byKind) this.folderOf.set(f.account_id, (byKind = new Map()))
      if (f.kind !== 'custom' && !byKind.has(f.kind)) byKind.set(f.kind, f.id)
      if (f.kind === 'important') this.accountsWithImportant.add(f.account_id)
    }
    this.ownEmails = new Set(this.accounts().map((a) => a.email.toLowerCase()))
    this.compiled = compileSplitRules(this.rules.effective())
  }

  // ---- Split rules -----------------------------------------------------------------------

  splitRules(): SplitRuleRow[] {
    return [...this.compiled.rules]
  }

  editSplitRule(id: string, rule: SplitRuleRow | null): void {
    this.tx(() => {
      this.rules.edit(id, rule)
      this.compiled = compileSplitRules(this.rules.effective())
    })
    this.queueResplit()
  }

  resplitPending(): number {
    return this.resplitIds.length
  }

  resplitStep(max = RESPLIT_CHUNK): number {
    const ids = this.resplitIds.splice(0, max)
    // Re-evaluates rather than replaying a stale verdict: a delta may have moved the thread.
    if (ids.length) this.tx(() => this.classify(ids))
    return this.resplitIds.length
  }

  pendingSplitRules(): PendingSplitRule[] {
    return this.rules.pending()
  }

  ackSplitRule(sent: PendingSplitRule): void {
    // What the user sees does not change: the accepted edit becomes the synced row.
    this.tx(() => this.rules.ack(sent))
  }

  rejectSplitRule(id: string): void {
    this.tx(() => {
      this.rules.reject(id)
      this.compiled = compileSplitRules(this.rules.effective())
    })
    this.queueResplit()
  }

  // ---- Snippets and follow-up nudges ------------------------------------------------------

  snippets(): SnippetRow[] {
    return this.snippetRows.effective().sort((a, b) => a.name.localeCompare(b.name))
  }

  editSnippet(id: string, snippet: SnippetRow | null): void {
    this.tx(() => this.snippetRows.edit(id, snippet))
  }

  dismissNudges(threadIds: readonly string[], dismiss: boolean): void {
    this.tx(() => {
      for (const ids of chunks(threadIds))
        for (const t of this.db.all<{ id: string; at: number }>(
          `SELECT id, last_message_at AS at FROM threads WHERE id IN (${marks(ids.length)})`,
          ids,
        ))
          this.dismissals.edit(t.id, dismiss ? { id: t.id, lastMessageAt: t.at } : null)
    })
  }

  followUps(now: number, opts: NudgeOptions = {}, limit = 100): FollowUpItem[] {
    const own = [...this.ownEmails]
    if (!own.length) return []
    const after = opts.afterMs ?? DEFAULT_AFTER
    const window = opts.windowMs ?? DEFAULT_WINDOW
    // Candidates: threads whose latest message is Zach's, in the nudge window. The age and
    // sender filters run in SQLite so only a handful of rows cross into JS.
    const rows = this.db.all<ThreadSqlRow & { mdata: string }>(
      `SELECT t.*, m.data AS mdata FROM threads t
       JOIN messages m ON m.id = (SELECT l.id FROM messages l WHERE l.thread_id = t.id
         ORDER BY l.date DESC, l.id DESC LIMIT 1)
       WHERE t.last_message_at BETWEEN ? AND ? AND m.from_email IN (${marks(own.length)})`,
      [now - window, now - after, ...own],
    )
    if (!rows.length) return []
    const skipFolderIds = new Set(
      [...this.folderKind].filter(([, k]) => k === 'trash' || k === 'spam').map(([id]) => id),
    )
    const dismissals = new Map(this.dismissals.effective().map((d) => [d.id, d.lastMessageAt]))
    const ctx = { ownEmails: this.ownEmails, skipFolderIds, dismissals, now }
    const out: FollowUpItem[] = []
    for (const r of rows) {
      const thread = toListItem(r)
      const n = followUpNudge(thread, [JSON.parse(r.mdata) as MessageRow], ctx, opts)
      if (n) out.push({ ...n, thread })
    }
    return out.sort((a, b) => b.dueAt - a.dueAt).slice(0, limit)
  }

  composerEdits(): ComposerEdit[] {
    return [
      ...this.snippetRows.pending().map((p) => ({ kind: 'snippet' as const, ...p })),
      ...this.dismissals.pending().map((p) => ({ kind: 'nudge' as const, ...p })),
    ]
  }

  ackComposerEdit(sent: ComposerEdit): void {
    this.tx(() =>
      sent.kind === 'snippet' ? this.snippetRows.ack(sent) : this.dismissals.ack(sent),
    )
  }

  rejectComposerEdit(sent: ComposerEdit): void {
    this.tx(() =>
      sent.kind === 'snippet' ? this.snippetRows.reject(sent.id) : this.dismissals.reject(sent.id),
    )
  }

  /** Runs a query whose single row/column is JSON text, so results cross wasm in one string. */
  private json<T>(sql: string, params: readonly SqlValue[] = []): T {
    const r = this.db.all<{ j: string | null }>(sql, params)[0]
    return JSON.parse(r?.j ?? 'null') as T
  }

  /**
   * Recomputes the split column for the given threads, for every thread when null, or for
   * the threads already in a split for 'inbox' (all a rules-only change can move), with the
   * same core evaluation the server runs on ingest.
   */
  private classify(threadIds: string[] | null): void {
    this.writeSplits(this.evaluate(threadIds))
  }

  /**
   * After a rules change: finds the inbox threads whose split moves, reading the inputs cached
   * on each thread (no message subqueries), and queues them. Writing them is the slow part
   * (one scattered page per thread), so the caller writes in chunks and the worker stays free
   * for list reads in between.
   */
  private queueResplit(): void {
    const ids = new Set(this.resplitIds)
    for (const [id] of this.evaluate('inbox')) ids.add(id)
    this.resplitIds = [...ids]
  }

  private evaluate(threadIds: string[] | null | 'inbox'): SplitChange[] {
    type Row = [
      id: string,
      accountId: string,
      subject: string,
      folderIds: string[],
      split: string | null,
      listUnsub: number,
      /** Latest 5 senders, newest first; null on the 'inbox' path, which reads `from`. */
      senders: (string | null)[] | null,
      first: string | null,
      recipients: string[] | null,
      from: string | null,
      storedListUnsub: number,
    ]
    const rules = this.compiled
    // Recipients cost a JSON walk per message, so they are gathered only when a rule asks.
    const recipients = rules.needsRecipients ? RECIPIENTS_SQL : 'NULL'
    // A rules-only change reads the sender and List-Unsubscribe flag cached on the thread by
    // the last full pass: no per-thread message subqueries, so 20k threads stay cheap.
    const cached = threadIds === 'inbox'
    const sql = (where: string) => `
      SELECT json_group_array(json_array(t.id, t.account_id, t.subject, json(t.folder_ids), t.split,
        ${
          cached
            ? 't.list_unsub, NULL, NULL'
            : `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.list_unsubscribe = 1),
        json((SELECT json_group_array(from_email) FROM (
           SELECT from_email FROM messages m WHERE m.thread_id = t.id
           ORDER BY m.date DESC LIMIT 5))),
        lower(t.participants ->> '$[0].email')`
        },
        ${recipients}, t.split_from, t.list_unsub)) AS j
      FROM threads t ${where}`
    const rows: Row[] = cached
      ? this.json<Row[]>(sql('WHERE t.split IS NOT NULL'))
      : threadIds
        ? chunks(threadIds).flatMap((ids) =>
            this.json<Row[]>(sql(`WHERE t.id IN (${marks(ids.length)})`), ids),
          )
        : this.json<Row[]>(sql(''))
    const changed: SplitChange[] = []
    for (const row of rows) {
      const [id, accountId, subject, folderIds, prev, lu, senders, first, rcpt, from0, lu0] = row
      const from = senders ? inboundSender(senders, this.ownEmails, first) : from0
      const split = rules.test({
        accountId,
        subject,
        folderIds,
        folderKinds: folderIds.map((f) => this.folderKind.get(f)).filter((k) => k !== undefined),
        accountHasImportant: this.accountsWithImportant.has(accountId),
        hasListUnsubscribe: !!lu,
        fromEmail: from,
        recipients: rcpt ?? undefined,
      })
      if (split !== prev || from !== from0 || +!!lu !== lu0) changed.push([id, split, from, +!!lu])
    }
    return changed
  }

  private writeSplits(changed: SplitChange[]): void {
    if (!changed.length) return
    this.db.run(
      `UPDATE threads SET split = c.value ->> 1, split_from = c.value ->> 2,
         list_unsub = c.value ->> 3
       FROM jsonb_each(?) AS c WHERE threads.id = c.value ->> 0`,
      [JSON.stringify(changed)],
    )
  }
}

type SplitChange = [id: string, split: SplitKey | null, from: string | null, listUnsub: number]

const RESPLIT_CHUNK = 200
const DEFAULT_AFTER = DEFAULT_NUDGE_AFTER_MS
const DEFAULT_WINDOW = DEFAULT_NUDGE_WINDOW_MS

// Every to/cc address in a thread, lowercased, as a JSON array.
const RECIPIENTS_SQL = `json((SELECT json_group_array(DISTINCT e) FROM (
  SELECT lower(r.value ->> 'email') AS e FROM messages m, json_each(m.data, '$.to') r
  WHERE m.thread_id = t.id
  UNION ALL
  SELECT lower(r.value ->> 'email') FROM messages m, json_each(m.data, '$.cc') r
  WHERE m.thread_id = t.id)))`

function listWhere(q: ListQuery): [string, SqlValue[]] {
  return q.accountId
    ? ['account_id = ? AND split = ?', [q.accountId, q.split]]
    : ['split = ?', [q.split]]
}

function toListItem(r: ThreadSqlRow): ThreadListItem {
  return {
    id: r.id,
    accountId: r.account_id,
    subject: r.subject,
    snippet: r.snippet,
    participants: JSON.parse(r.participants) as Address[],
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
    unread: !!r.unread,
    starred: !!r.starred,
    hasAttachments: !!r.has_attachments,
    folderIds: JSON.parse(r.folder_ids) as string[],
  }
}

const queued = (env: OpEnvelope, sent: boolean): QueuedOp => ({
  env,
  threads: new Set(env.op.threadIds),
  sent,
})

const pick = ({ folderIds, unread, starred }: Overlayable): Overlayable => ({
  folderIds,
  unread,
  starred,
})

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

function chunks<T>(arr: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK))
  return out
}
