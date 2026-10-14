import {
  parseQuery,
  planQuery,
  toFts5,
  type MessageBody,
  type MessageRow,
  type Rows,
  type SearchContext,
  type SearchPlan,
  type ThreadRow,
} from '@zachmail/core'
import type { SqlDriver, SqlValue } from './driver'
import type { StoreApi, ThreadListItem } from './store'

/** A search as a list view: what ListModel pages through instead of a split. */
export interface SearchListQuery {
  search: string
  /** Client's Date#getTimezoneOffset, so dates in the query mean local midnight. */
  tzOffset?: number
}

export const isSearchQuery = (q: object): q is SearchListQuery => 'search' in q

/** Bump to rebuild the index from the replica on next open. */
const INDEX_VERSION = '1'

// Columns line up with the server's tsvector weights: subject, sender, recipients, body.
const SCHEMA = /* sql */ `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  subject, sender, recipients, body,
  content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);
-- Results list newest first: walk threads in this order and stop at the page.
CREATE INDEX IF NOT EXISTS threads_recent ON threads (last_message_at DESC, id DESC);
-- What matching reads of a thread, so finding thousands of them never touches the table
-- (larger than the page cache, so cold reads of it cost hundreds of ms).
CREATE INDEX IF NOT EXISTS threads_search ON threads (
  id, account_id, last_message_at, folder_ids, unread, starred, has_attachments
);
CREATE TEMP TABLE IF NOT EXISTS search_hits (id TEXT PRIMARY KEY) WITHOUT ROWID;
-- Plain text of cached bodies (HTML stripped in JS), so re-synced messages keep it indexed.
CREATE TABLE IF NOT EXISTS search_bodies (message_id TEXT PRIMARY KEY, text TEXT NOT NULL);
`

const addresses = (path: string) => `(SELECT coalesce(group_concat(
    coalesce(value ->> 'name', '') || ' ' || coalesce(value ->> 'email', ''), ' '), '')
  FROM json_each(m.data, '${path}'))`

/** Index rows for the messages matched by `where` (an expression over `m`). */
const indexRows = (where: string) => /* sql */ `
INSERT INTO messages_fts (rowid, subject, sender, recipients, body)
SELECT m.rowid, m.data ->> '$.subject',
  coalesce(m.data ->> '$.from.name', '') || ' ' || coalesce(m.data ->> '$.from.email', ''),
  ${addresses('$.to')} || ' ' || ${addresses('$.cc')},
  coalesce(m.data ->> '$.snippet', '') || ' ' || coalesce(sb.text, '')
FROM messages m LEFT JOIN search_bodies sb ON sb.message_id = m.id
WHERE ${where};`

// The store upserts with INSERT OR REPLACE, whose implicit delete fires no triggers, so the
// old index row goes in a BEFORE INSERT trigger instead.
const TRIGGERS = /* sql */ `
CREATE TRIGGER IF NOT EXISTS messages_fts_bi BEFORE INSERT ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
  ${indexRows('m.id = NEW.id')}
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF data ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
  ${indexRows('m.id = NEW.id')}
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;
CREATE TRIGGER IF NOT EXISTS search_bodies_ai AFTER INSERT ON search_bodies BEGIN
  DELETE FROM messages_fts WHERE rowid = (SELECT rowid FROM messages WHERE id = NEW.message_id);
  ${indexRows('m.id = NEW.message_id')}
END;
CREATE TRIGGER IF NOT EXISTS bodies_search_ad AFTER DELETE ON bodies BEGIN
  DELETE FROM search_bodies WHERE message_id = OLD.message_id;
END;
`

const LIST_ITEM = `json_object('id', t.id, 'accountId', t.account_id,
  'subject', t.subject, 'snippet', t.snippet, 'participants', json(t.participants),
  'lastMessageAt', t.last_message_at, 'messageCount', t.message_count,
  'unread', json(iif(t.unread, 'true', 'false')),
  'starred', json(iif(t.starred, 'true', 'false')),
  'hasAttachments', json(iif(t.has_attachments, 'true', 'false')),
  'folderIds', json(t.folder_ids))`

/**
 * Local full-text search over the replica (SQLite FTS5), kept current by triggers on the
 * store's tables, so results come back in a few milliseconds as Zach types. Pages like a
 * split list (count / list / indexOf) so the inbox view renders results unchanged.
 */
export class SearchIndex {
  /** Threads the server matched for a query (e.g. on a body the replica hasn't cached). */
  private remote = new Map<string, Set<string>>()
  private cached: { key: string; stamp: number; count: number } | null = null

  constructor(
    private db: SqlDriver,
    private store: Pick<StoreApi, 'accounts' | 'folders'>,
  ) {
    const v = db.all<{ value: string }>(`SELECT value FROM meta WHERE key = 'search_index'`)[0]
    if (v?.value !== INDEX_VERSION) {
      // New install, or the store dropped its tables for a schema bump: rebuild from rows.
      db.exec('DROP TABLE IF EXISTS messages_fts; DROP TABLE IF EXISTS search_bodies;')
      db.exec(SCHEMA)
      db.exec(TRIGGERS)
      this.rebuild()
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('search_index', ?)`, [INDEX_VERSION])
    } else {
      db.exec(SCHEMA)
      db.exec(TRIGGERS)
    }
  }

  /**
   * Reads the indexes matching walks into the page cache. A first query otherwise pays for
   * them from storage (tens of ms in a browser), which lands on the first keystrokes.
   */
  warm(): void {
    this.db.all(`SELECT count(*) FROM messages INDEXED BY messages_thread WHERE thread_id > ''`)
    this.db.all(`SELECT count(*) FROM threads INDEXED BY threads_search WHERE id > ''`)
    this.db.all(`SELECT count(*) FROM threads INDEXED BY threads_recent WHERE last_message_at > 0`)
  }

  countThreads(q: SearchListQuery): number {
    return this.hits(q)
  }

  listThreads(q: SearchListQuery, offset: number, limit: number): ThreadListItem[] {
    if (!this.hits(q)) return []
    const r = this.db.all<{ j: string }>(
      // Page the ids first: building JSON for every hit before the LIMIT would cost more.
      `SELECT json_group_array(json(j)) AS j FROM (
         SELECT ${LIST_ITEM} AS j FROM (
           SELECT id FROM threads INDEXED BY threads_search WHERE id IN (SELECT id FROM search_hits)
           ORDER BY last_message_at DESC, id DESC LIMIT ? OFFSET ?) p
         JOIN threads t ON t.id = p.id ORDER BY t.last_message_at DESC, t.id DESC)`,
      [limit, offset],
    )[0]
    return JSON.parse(r?.j ?? '[]') as ThreadListItem[]
  }

  indexOfThread(q: SearchListQuery, threadId: string): number {
    if (!this.hits(q)) return -1
    const t = this.db.all<{ at: number }>(
      `SELECT t.last_message_at AS at FROM search_hits h
       JOIN threads t INDEXED BY threads_search ON t.id = h.id WHERE h.id = ?`,
      [threadId],
    )[0]
    if (!t) return -1
    return this.db.all<{ n: number }>(
      `SELECT count(*) AS n FROM search_hits h JOIN threads t INDEXED BY threads_search ON t.id = h.id
       WHERE t.last_message_at > ? OR (t.last_message_at = ? AND t.id > ?)`,
      [t.at, t.at, threadId],
    )[0]!.n
  }

  /** Indexes the text of freshly cached bodies. */
  indexBodies(bodies: readonly MessageBody[]): void {
    if (!bodies.length) return
    this.db.run(
      `INSERT OR REPLACE INTO search_bodies (message_id, text)
       SELECT value ->> 0, value ->> 1 FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM messages WHERE id = value ->> 0)`,
      [JSON.stringify(bodies.map((b) => [b.messageId, htmlToText(b.html)]))],
    )
  }

  /**
   * Takes a page of server results: threads the replica lacks are returned for the caller to
   * apply (rows the replica has are already newer, via sync), and every result is kept as a
   * match for this query even if the replica can't see why (an uncached body).
   */
  addRemote(
    q: SearchListQuery,
    page: { threads: ThreadRow[]; messages: MessageRow[] },
  ): Pick<Rows, 'threads' | 'messages'> {
    const ids = page.threads.map((t) => t.id)
    const key = q.search.trim()
    const set = this.remote.get(key) ?? new Set()
    for (const id of ids) set.add(id)
    // Only the query being looked at matters; keep the last few for back-and-forth edits.
    this.remote.delete(key)
    this.remote.set(key, set)
    while (this.remote.size > 8) this.remote.delete(this.remote.keys().next().value!)
    this.cached = null

    const have = new Set(
      this.db
        .all<{ id: string }>(
          `SELECT id FROM threads WHERE id IN (SELECT value FROM json_each(?))`,
          [JSON.stringify(ids)],
        )
        .map((r) => r.id),
    )
    const threads = page.threads.filter((t) => !have.has(t.id))
    const fresh = new Set(threads.map((t) => t.id))
    return { threads, messages: page.messages.filter((m) => fresh.has(m.threadId)) }
  }

  /**
   * Materializes the threads matching `q` into temp.search_hits and returns how many, so a
   * keystroke costs one match however many pages and counts the list then asks for. Redone
   * when the query or anything in the database changes.
   */
  private hits(q: SearchListQuery): number {
    const key = `${q.tzOffset ?? ''}|${q.search}`
    if (this.cached?.key === key && this.cached.stamp === this.stamp()) return this.cached.count
    const w = this.where(q)
    this.db.run('DELETE FROM search_hits')
    if (w)
      this.db.run(
        `INSERT INTO search_hits (id) SELECT t.id FROM threads t INDEXED BY threads_search WHERE ${w[0]}`,
        w[1],
      )
    const count = w ? this.db.all<{ n: number }>(`SELECT count(*) AS n FROM search_hits`)[0]!.n : 0
    this.cached = { key, stamp: this.stamp(), count }
    return count
  }

  /** Changes this connection has made, triggers included: any sync write moves it. */
  private stamp(): number {
    return this.db.all<{ n: number }>(`SELECT total_changes() AS n`)[0]!.n
  }

  private plan(q: SearchListQuery): SearchPlan | null {
    const parsed = parseQuery(q.search, { tzOffset: q.tzOffset })
    // Provider-only syntax can't be evaluated here; results come from the server alone.
    if (!parsed.clauses.length || parsed.providerOnly) return null
    return planQuery(parsed, this.context())
  }

  private context(): SearchContext {
    return {
      accounts: this.store.accounts(),
      folders: this.store.folders(),
    }
  }

  /** WHERE over `threads t` for a query, or null when nothing can match. */
  private where(q: SearchListQuery): [string, SqlValue[]] | null {
    const remote = this.remote.get(q.search.trim())
    const plan = this.plan(q)
    const params: SqlValue[] = []
    const local = plan ? planWhere(plan, params) : null
    if (!remote?.size) return local ? [local, params] : null
    const extra = `t.id IN (SELECT value FROM json_each(?))`
    params.push(JSON.stringify([...remote]))
    return [local ? `((${local}) OR ${extra})` : extra, params]
  }

  private rebuild() {
    this.db.exec('BEGIN')
    try {
      // Bodies cached before the index existed: strip them once, in chunks.
      for (let after = ''; ;) {
        const rows = this.db.all<{ message_id: string; html: string }>(
          `SELECT message_id, html FROM bodies WHERE message_id > ? ORDER BY message_id LIMIT 200`,
          [after],
        )
        if (!rows.length) break
        this.db.run(
          `INSERT OR REPLACE INTO search_bodies (message_id, text) SELECT value ->> 0, value ->> 1 FROM json_each(?)`,
          [JSON.stringify(rows.map((r) => [r.message_id, htmlToText(r.html)]))],
        )
        after = rows.at(-1)!.message_id
      }
      this.db.exec('DELETE FROM messages_fts')
      this.db.exec(indexRows('1'))
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** Appends to `params` in the order the placeholders appear. */
function planWhere(plan: SearchPlan, params: SqlValue[]): string {
  const w: string[] = []
  if (plan.accountIds) {
    w.push(`t.account_id IN (${marks(plan.accountIds.length)})`)
    params.push(...plan.accountIds)
  }
  // folder_ids is a JSON array of ids; a substring test on it is far cheaper than json_each.
  for (const f of plan.folders) {
    const any = f.ids.map(() => `instr(t.folder_ids, ?) > 0`).join(' OR ')
    w.push(f.negated ? `NOT (${any})` : `(${any})`)
    params.push(...f.ids.map((id) => JSON.stringify(id)))
  }

  // Per message, like the server. Text and dates are answered from messages_thread alone
  // (thread_id, date, rowid): the table itself is far bigger than the page cache, and reading
  // its rows for thousands of matches is what makes a short prefix slow.
  const m: string[] = []
  const fts = 'SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?'
  const pos = plan.match.filter((t) => !t.negated)
  const text = pos.length ? pos.map(toFts5).join(' AND ') : null
  if (text) m.push(`m.rowid IN (${fts})`)
  const negated = plan.match.filter((t) => t.negated).map(toFts5)
  for (let i = 0; i < negated.length; i++) m.push(`m.rowid NOT IN (${fts})`)
  if (plan.after !== undefined) m.push('m.date >= ?')
  if (plan.before !== undefined) m.push('m.date < ?')
  const indexed = (): SqlValue[] => [
    ...(text ? [text] : []),
    ...negated,
    ...(plan.after !== undefined ? [plan.after] : []),
    ...(plan.before !== undefined ? [plan.before] : []),
  ]

  // Flags need the rows, so they are checked only within threads whose own flag (any of its
  // messages) already says they can match.
  const flags: string[] = []
  const flagParams: SqlValue[] = []
  const flag = (col: string, thread: string, v: boolean | undefined) => {
    if (v === undefined) return
    flags.push(`${col} = ?`)
    flagParams.push(+v)
    if (v) w.push(`t.${thread} = 1`)
  }
  flag('m.unread', 'unread', plan.unread)
  flag(`(m.data ->> '$.starred')`, 'starred', plan.starred)
  flag(`(m.data ->> '$.hasAttachments')`, 'has_attachments', plan.attachment)

  if (m.length) {
    w.push(
      `t.id IN (SELECT m.thread_id FROM messages m INDEXED BY messages_thread WHERE ${m.join(' AND ')})`,
    )
    params.push(...indexed())
  }
  if (flags.length) {
    w.push(
      `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND ${[...flags, ...m].join(' AND ')})`,
    )
    params.push(...flagParams, ...indexed())
  }
  return w.length ? w.join(' AND ') : '1'
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

/** Searchable text of sanitized email HTML (no DOM in a worker; good enough for tokens). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? ' '
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
    })
    .replace(/\s+/g, ' ')
    .trim()
}
