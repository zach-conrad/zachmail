/**
 * Hub search (ZACHHUB_PLAN.md §5): one query over hub.search_index, which applyEntityOps fills
 * for kinds that declare `search`, unioned with the mail mirror's own per-message index
 * (searchMirror), so mail is never indexed twice. Server side only; no provider fallback.
 */
import {
  HUB_SEARCH_PAGE,
  MAIL_THREAD_KIND,
  MAX_SEARCH_PAGE,
  moduleScope,
  parseQuery,
  planQuery,
  toTsQuery,
  type HubSearchHit,
  type HubSearchResponse,
  type ParsedQuery,
  type SearchPlan,
} from '@zachhub/core'
import type { EntityRegistry } from './entities'
import { loadSearchContext, searchMirror } from './search'
import type { Queryable } from './sql'

export interface HubSearchOptions {
  /** Kinds declaring `search` are searched; their module names are what `in:` accepts. */
  registry: EntityRegistry
  limit?: number
  /** Client's Date#getTimezoneOffset, for dates in the query. */
  tzOffset?: number
  now?: number
}

const MAIL = 'mail'
const SNIPPET = 200
const moduleOf = (kind: string) => kind.slice(0, kind.indexOf('.'))

/** Folders, labels, accounts, flags or provider syntax: only mail has those. */
const mailOnly = (q: ParsedQuery) => q.clauses.some((c) => c.kind !== 'match' && c.kind !== 'date')

/**
 * Module rows and mail threads matching a query, best first (rank, then newest). Dates bound a
 * row's last change. `in:<module>` alone lists that module's newest rows.
 */
export async function searchHub(
  db: Queryable,
  userId: string,
  query: string,
  opts: HubSearchOptions,
): Promise<HubSearchResponse> {
  const limit = Math.min(Math.max(opts.limit ?? HUB_SEARCH_PAGE, 1), MAX_SEARCH_PAGE)
  const parsed = parseQuery(query, { tzOffset: opts.tzOffset, now: opts.now })
  if (!parsed.clauses.length) return { hits: [], highlight: [] }
  const kinds = opts.registry.tables.filter((t) => t.search).map((t) => t.kind)
  const scope = moduleScope(parsed, [MAIL, ...new Set(kinds.map(moduleOf))])
  const plan = planQuery(scope.query, await loadSearchContext(db, userId))
  if (!plan) return { hits: [], highlight: [] }

  const indexed = mailOnly(scope.query)
    ? []
    : kinds.filter((k) => scope.modules.includes(moduleOf(k)))
  const [rows, mail] = await Promise.all([
    indexed.length ? searchIndex(db, userId, plan, indexed, limit) : [],
    // Provider-only syntax can't be evaluated against the mirror (see searchMail).
    scope.modules.includes(MAIL) && !scope.query.providerOnly
      ? searchMailThreads(db, userId, plan, limit)
      : [],
  ])
  const hits = [...rows, ...mail]
    .sort((a, b) => b.rank - a.rank || b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
    .slice(0, limit)
  return { hits, highlight: plan.highlight }
}

/**
 * Words to compare with titles by trigram similarity, catching typos the full-text match
 * misses. Only for plain positive words: a fuzzy hit must not slip past a negation or field.
 */
function fuzzyWords(plan: SearchPlan): string[] {
  const plain = plan.match.every(
    (t) => !t.negated && t.alts.length === 1 && (t.field === 'any' || t.field === 'subject'),
  )
  return plain ? plan.match.flatMap((t) => t.alts[0]!) : []
}

async function searchIndex(
  db: Queryable,
  userId: string,
  plan: SearchPlan,
  kinds: string[],
  limit: number,
): Promise<HubSearchHit[]> {
  const params: unknown[] = [userId, kinds]
  const p = (v: unknown) => `$${params.push(v)}`
  const where = ['s.user_id = $1', 's.entity_kind = ANY($2::text[])']
  let rank = '0'

  // Same tsquery as mail: weights A (subject: → title) and D match; B and C (from:, to:) never.
  const ts = toTsQuery(plan.match)
  if (ts) {
    const q = `to_tsquery('simple', ${p(ts)})`
    // Every word close to some word of the title; similarity adds a little to the rank.
    const fuzzy = fuzzyWords(plan).map(p)
    if (fuzzy.length) {
      const close = fuzzy.map((w) => `${w} OPERATOR(extensions.<%) s.title`)
      const sim = fuzzy.map((w) => `extensions.word_similarity(${w}, s.title)`)
      where.push(`(s.tsv @@ ${q} OR (${close.join(' AND ')}))`)
      rank = `ts_rank(s.tsv, ${q}) + (${sim.join(' + ')}) / ${fuzzy.length * 10}`
    } else {
      where.push(`s.tsv @@ ${q}`)
      rank = `ts_rank(s.tsv, ${q})`
    }
  }
  if (plan.after !== undefined) where.push(`s.updated_at >= to_timestamp(${p(plan.after / 1000)})`)
  if (plan.before !== undefined) where.push(`s.updated_at < to_timestamp(${p(plan.before / 1000)})`)

  return db.query<HubSearchHit>(
    `SELECT s.entity_kind AS kind, s.entity_id::text AS id, s.title,
       left(s.body, ${SNIPPET}) AS snippet,
       (extract(epoch FROM s.updated_at) * 1000)::float8 AS "updatedAt", (${rank})::float8 AS rank
     FROM hub.search_index s WHERE ${where.join(' AND ')}
     ORDER BY rank DESC, s.updated_at DESC, s.entity_id DESC LIMIT ${p(limit)}`,
    params,
  )
}

/**
 * Mail through the mirror's search: its newest `limit` matching threads, each ranked by its
 * best-matching message so they sort among module rows.
 */
async function searchMailThreads(
  db: Queryable,
  userId: string,
  plan: SearchPlan,
  limit: number,
): Promise<HubSearchHit[]> {
  const threads = await searchMirror(db, userId, plan, { limit })
  const ts = toTsQuery(plan.match)
  const ranks = new Map<string, number>()
  if (ts && threads.length) {
    const rows = await db.query<{ id: string; rank: number }>(
      `SELECT thread_id::text AS id, max(ts_rank(search, to_tsquery('simple', $3)))::float8 AS rank
       FROM messages WHERE user_id = $1 AND thread_id = ANY($2::uuid[])
         AND search @@ to_tsquery('simple', $3)
       GROUP BY thread_id`,
      [userId, threads.map((t) => t.id), ts],
    )
    for (const r of rows) ranks.set(r.id, r.rank)
  }
  return threads.map((t) => ({
    kind: MAIL_THREAD_KIND,
    id: t.id,
    title: t.subject,
    snippet: t.snippet,
    updatedAt: t.lastMessageAt,
    rank: ranks.get(t.id) ?? 0,
  }))
}
