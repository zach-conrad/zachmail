import {
  MAX_SEARCH_PAGE,
  SEARCH_PAGE,
  parseQuery,
  planQuery,
  toGmailQuery,
  type SearchResponse,
  type ThreadRow,
} from '@zachmail/core'
import {
  applySyncBatch,
  loadSearchContext,
  mirrorHorizons,
  mirroredThreadIds,
  nudge,
  readMessages,
  readThreads,
  searchMirror,
  type Db,
} from '@zachmail/db/server'
import { ProviderAuthError } from '@zachmail/providers'
import { getAccount, type ProviderFactory } from './accounts'

export interface SearchArgs {
  q: string
  limit?: number
  cursor?: string | null
  /** Skip threads the client's replica holds: last activity at or after this (epoch ms). */
  olderThan?: number | null
  /** Client's Date#getTimezoneOffset. */
  tzOffset?: number
}

/**
 * Where a search continues. `m`: more mirror results after this thread. `p`: the mirror is
 * exhausted; the provider is being paged per account (null token = first page).
 */
interface Cursor {
  m?: { at: number; id: string }
  p?: Record<string, string | null>
}

export class BadCursorError extends Error {
  override name = 'BadCursorError'
}

const encode = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url')

function decode(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString()) as Cursor
    if (typeof c !== 'object' || c === null) throw new Error()
    if (c.m && (typeof c.m.at !== 'number' || typeof c.m.id !== 'string')) throw new Error()
    if (
      c.p &&
      (typeof c.p !== 'object' ||
        Object.values(c.p).some((v) => v !== null && typeof v !== 'string'))
    )
      throw new Error()
    return c
  } catch {
    throw new BadCursorError('Bad cursor')
  }
}

const empty = (highlight: string[] = []): SearchResponse => ({
  threads: [],
  messages: [],
  highlight,
  nextCursor: null,
  source: 'mirror',
})

/**
 * Searches the server mirror, then (page by page, as the client asks for more) the provider
 * for mail the mirror doesn't hold yet: older than its backfill, or a query using operators
 * only the provider understands. Provider hits are written into the mirror, so they open,
 * sync and triage like any other thread.
 */
export async function searchMail(
  db: Db,
  providers: ProviderFactory,
  userId: string,
  args: SearchArgs,
): Promise<SearchResponse> {
  const limit = Math.min(Math.max(args.limit ?? SEARCH_PAGE, 1), MAX_SEARCH_PAGE)
  const cursor = args.cursor ? decode(args.cursor) : {}
  const parsed = parseQuery(args.q, { tzOffset: args.tzOffset })
  if (!parsed.clauses.length) return empty()
  const plan = planQuery(parsed, await loadSearchContext(db, userId))
  if (!plan) return empty()

  if (!cursor.p) {
    if (!parsed.providerOnly) {
      const rows = await searchMirror(db, userId, plan, {
        limit: limit + 1,
        after: cursor.m ?? null,
        olderThan: args.olderThan ?? null,
      })
      if (rows.length > limit) {
        const page = rows.slice(0, limit)
        const last = page.at(-1)!
        return {
          ...(await withMessages(db, userId, page)),
          highlight: plan.highlight,
          nextCursor: encode({ m: { at: last.lastMessageAt, id: last.id } }),
          source: 'mirror',
        }
      }
      const accounts = await providerAccounts(db, userId, plan.accountIds, false)
      return {
        ...(await withMessages(db, userId, rows)),
        highlight: plan.highlight,
        nextCursor: accounts.length
          ? encode({ p: Object.fromEntries(accounts.map((a) => [a, null])) })
          : null,
        source: 'mirror',
      }
    }
    // Provider-only syntax: the mirror can't evaluate it, so go straight to the provider.
    cursor.p = Object.fromEntries(
      (await providerAccounts(db, userId, plan.accountIds, true)).map((a) => [a, null]),
    )
  }

  const horizons = parsed.providerOnly
    ? new Map<string, number>()
    : await mirrorHorizons(db, userId)
  const next: Record<string, string | null> = {}
  const found: string[] = []
  let changed = false
  await Promise.all(
    Object.entries(cursor.p).map(async ([accountId, pageToken]) => {
      const account = await getAccount(db, accountId)
      if (!account || account.userId !== userId || account.status === 'disabled') return
      try {
        const provider = providers.forAccount(account)
        const page = await provider.searchThreads(
          toGmailQuery(parsed, { before: horizons.get(accountId) }),
          { limit, pageToken },
        )
        let known = await mirroredThreadIds(db, accountId, page.providerThreadIds)
        const missing = page.providerThreadIds.filter((id) => !known.has(id))
        if (missing.length) {
          const batch = await provider.fetchThreads(missing)
          const r = await applySyncBatch(db, { userId, accountId, batch })
          changed ||= r.changed > 0
          known = await mirroredThreadIds(db, accountId, page.providerThreadIds)
        }
        for (const id of page.providerThreadIds) {
          const tid = known.get(id)
          if (tid) found.push(tid)
        }
        if (page.pageToken) next[accountId] = page.pageToken
      } catch (err) {
        // One account needing reauth shouldn't sink the others' results.
        if (!(err instanceof ProviderAuthError)) throw err
      }
    }),
  )
  if (changed) await nudge(db, userId)

  const { threads, messages } = await readThreads(db, userId, [...new Set(found)])
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : -1))
  return {
    threads,
    messages,
    highlight: plan.highlight,
    nextCursor: Object.keys(next).length ? encode({ p: next }) : null,
    source: 'provider',
  }
}

async function withMessages(db: Db, userId: string, threads: ThreadRow[]) {
  return {
    threads,
    messages: await readMessages(
      db,
      userId,
      threads.map((t) => t.id),
    ),
  }
}

/**
 * Accounts the provider fallback should ask: Gmail accounts in scope whose mirror is not yet
 * complete, or all of them when the query needs the provider anyway.
 */
async function providerAccounts(
  db: Db,
  userId: string,
  accountIds: string[] | null,
  all: boolean,
): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1 AND provider = 'gmail'
       AND status NOT IN ('disabled', 'needs_reauth', 'connecting')
       AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
       AND ($3 OR NOT COALESCE((sync_state ->> 'mirrorComplete')::boolean, false))
     ORDER BY created_at`,
    [userId, accountIds, all],
  )
  return rows.map((r) => r.id)
}
