import { opEffect, type FolderKind, type OpEffect, type OpEnvelope } from '@zachmail/core'
import type { Db, Queryable } from './sql'
import { recomputeThreads, recordChanges } from './sync'

/** Payload of a triage outbox row: thread and folder ids from our mirror. */
export interface TriagePayload extends OpEffect {
  threadIds: string[]
}

export interface AcceptResult {
  accepted: string[]
  rejected: { id: string; error: string }[]
  /** Accounts with new outbox rows, for the caller to enqueue a flush. */
  accounts: string[]
}

interface FolderRef {
  id: string
  accountId: string
  kind: FolderKind
  providerId: string
}

/**
 * Takes a batch of client ops: writes one outbox row per (op, account) and applies the same
 * effect to the mirror, so every other device sees the change on its next pull, before the
 * provider has been told. Replays of an op id are accepted without applying twice.
 */
export async function acceptOps(db: Db, userId: string, ops: OpEnvelope[]): Promise<AcceptResult> {
  return db.transaction(async (tx) => {
    const result: AcceptResult = { accepted: [], rejected: [], accounts: [] }
    const accounts = new Set<string>()
    const folders = new Map<string, FolderRef[]>()

    for (const { id, op } of ops) {
      const threads = await tx.query<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM threads WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [userId, op.threadIds],
      )
      if (!threads.length) {
        result.rejected.push({ id, error: 'Those conversations no longer exist' })
        continue
      }
      const byAccount = new Map<string, string[]>()
      for (const t of threads)
        byAccount.set(t.account_id, [...(byAccount.get(t.account_id) ?? []), t.id])
      await loadFolders(tx, [...byAccount.keys()], folders)

      for (const [accountId, threadIds] of byAccount) {
        const own = folders.get(accountId) ?? []
        const ownIds = new Set(own.map((f) => f.id))
        const effect = opEffect(op, (kind) => own.find((f) => f.kind === kind)?.id)
        effect.add = effect.add.filter((f) => ownIds.has(f))
        effect.remove = effect.remove.filter((f) => ownIds.has(f))
        const payload: TriagePayload = { threadIds, ...effect }

        const inserted = await tx.query(
          `INSERT INTO outbox (user_id, op_id, account_id, kind, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (op_id, account_id) DO NOTHING RETURNING id`,
          [userId, id, accountId, op.kind, payload],
        )
        if (!inserted.length) continue
        accounts.add(accountId)

        const provider = (ids: string[]) =>
          own.filter((f) => ids.includes(f.id)).map((f) => f.providerId)
        const changed = await tx.query<{ id: string }>(
          `WITH n AS (
             SELECT m.id, ARRAY(
               SELECT DISTINCT x FROM unnest(m.provider_labels || $2::text[]) AS x
               WHERE NOT (x = ANY($3::text[]))
             ) AS labels
             FROM messages m WHERE m.thread_id = ANY($1::uuid[])
           )
           UPDATE messages m SET provider_labels = n.labels,
             unread = COALESCE($4::boolean, m.unread), starred = COALESCE($5::boolean, m.starred),
             updated_at = now()
           FROM n WHERE m.id = n.id AND NOT (
             m.provider_labels @> n.labels AND n.labels @> m.provider_labels
             AND m.unread = COALESCE($4::boolean, m.unread)
             AND m.starred = COALESCE($5::boolean, m.starred))
           RETURNING m.id`,
          [
            threadIds,
            provider(effect.add),
            provider(effect.remove),
            effect.unread ?? null,
            effect.starred ?? null,
          ],
        )
        if (changed.length) {
          await recordChanges(
            tx,
            userId,
            'message',
            changed.map((m) => m.id),
            'upsert',
          )
          await recomputeThreads(tx, userId, threadIds)
          await recordChanges(tx, userId, 'thread', threadIds, 'upsert')
        }
      }
      await recordChanges(tx, userId, 'op', [id], 'upsert')
      result.accepted.push(id)
    }
    result.accounts = [...accounts]
    return result
  })
}

async function loadFolders(tx: Queryable, accountIds: string[], cache: Map<string, FolderRef[]>) {
  const missing = accountIds.filter((a) => !cache.has(a))
  if (!missing.length) return
  const rows = await tx.query<FolderRef>(
    `SELECT id, account_id AS "accountId", kind, provider_id AS "providerId"
     FROM folders WHERE account_id = ANY($1::uuid[])`,
    [missing],
  )
  for (const a of missing) cache.set(a, [])
  for (const f of rows) cache.get(f.accountId)!.push(f)
}

export interface OutboxItem {
  id: string
  opId: string
  userId: string
  accountId: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
}

/** An in-flight row older than this belongs to a dead worker and may be taken over. */
const STALE = `interval '2 minutes'`

/**
 * Claims the next row for an account. Rows run one at a time per account in `seq` order, so
 * an undo never overtakes the op it undoes. Sends waiting on `not_before` don't block the
 * line. Returns null when nothing is ready or another worker holds the account.
 */
export async function claimOutbox(db: Db, accountId: string): Promise<OutboxItem | null> {
  return db.transaction(async (tx) => {
    const [account] = await tx.query(`SELECT id FROM accounts WHERE id = $1 FOR UPDATE`, [
      accountId,
    ])
    if (!account) return null
    const [row] = await tx.query<OutboxItem>(
      `WITH head AS (
         SELECT id, state, not_before, locked_at FROM outbox
         WHERE account_id = $1 AND state IN ('pending', 'in_flight')
           AND (kind <> 'send' OR not_before <= now() OR state = 'in_flight')
         ORDER BY seq LIMIT 1
       )
       UPDATE outbox o SET state = 'in_flight', locked_at = now(), attempts = o.attempts + 1,
         updated_at = now()
       FROM head WHERE o.id = head.id AND (
         (head.state = 'pending' AND head.not_before <= now())
         OR (head.state = 'in_flight' AND head.locked_at < now() - ${STALE}))
       RETURNING o.id, o.op_id AS "opId", o.user_id AS "userId", o.account_id AS "accountId",
         o.kind, o.payload, o.attempts`,
      [accountId],
    )
    return row ?? null
  })
}

export type OutboxOutcome =
  | { state: 'done' }
  | { state: 'failed'; error: string }
  /** Transient failure: back to pending until `at`. */
  | { state: 'retry'; error: string; at: Date }

export async function finishOutbox(db: Db, item: OutboxItem, outcome: OutboxOutcome) {
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE outbox SET state = $2, last_error = $3, locked_at = NULL, updated_at = now(),
         not_before = COALESCE($4::timestamptz, not_before)
       WHERE id = $1`,
      [
        item.id,
        outcome.state === 'retry' ? 'pending' : outcome.state,
        outcome.state === 'done' ? null : outcome.error,
        outcome.state === 'retry' ? outcome.at.toISOString() : null,
      ],
    )
    if (outcome.state !== 'retry') await recordChanges(tx, item.userId, 'op', [item.opId], 'upsert')
  })
}

/** Puts a claimed row back untouched (e.g. the account needs reauth). */
export async function releaseOutbox(db: Queryable, item: OutboxItem) {
  await db.query(
    `UPDATE outbox SET state = 'pending', locked_at = NULL, attempts = attempts - 1, updated_at = now()
     WHERE id = $1`,
    [item.id],
  )
}

/** Accounts whose outbox has work nobody picked up (a lost job, a crashed worker). */
export async function stalledOutboxAccounts(db: Queryable) {
  return db.query<{ userId: string; accountId: string }>(
    `SELECT DISTINCT o.user_id AS "userId", o.account_id AS "accountId" FROM outbox o
     JOIN accounts a ON a.id = o.account_id AND a.status NOT IN ('needs_reauth', 'disabled')
     WHERE (o.state = 'pending' AND o.not_before < now() - interval '30 seconds')
        OR (o.state = 'in_flight' AND o.locked_at < now() - ${STALE})`,
  )
}
