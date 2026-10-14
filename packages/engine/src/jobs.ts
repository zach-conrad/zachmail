import { createAi, type Ai } from '@zachmail/ai'
import {
  WAKE_JOB,
  applySyncBatch,
  enqueueJob,
  markMirrorComplete,
  nudge,
  recomputeSplits,
  updateAccount,
  type Db,
} from '@zachmail/db/server'
import { ProviderAuthError, mapLimit } from '@zachmail/providers'
import { canWatch, getAccount, type AccountRecord, type ProviderFactory } from './accounts'
import { AI_TRIAGE_JOB, enqueueTriage, triageAccount } from './ai'
import { getMessageBody } from './bodies'
import type { EngineConfig } from './config'
import { DRAFT_JOB, syncDraft } from './drafts'
import { Storage } from './storage'
import {
  NOTIFY_JOB,
  NOTIFY_TEST_JOB,
  enqueueNotify,
  notifyNewMail,
  sendTestNotification,
  type PushSender,
} from './notify'
import { OUTBOX_JOB, enqueueOutboxFlush, flushOutbox, rearchiveMuted } from './outbox'
import { runWakeups } from './snooze'

export interface JobLike {
  kind: string
  userId: string
  payload: Record<string, unknown>
}

export type Handler = (job: JobLike) => Promise<void>

export const JOB = {
  backfill: 'mail.backfill',
  sync: 'account.sync',
  watch: 'gmail.watch',
  prefetch: 'bodies.prefetch',
  outbox: OUTBOX_JOB,
  draft: DRAFT_JOB,
  wake: WAKE_JOB,
  splits: 'splits.recompute',
  triage: AI_TRIAGE_JOB,
  notify: NOTIFY_JOB,
  notifyTest: NOTIFY_TEST_JOB,
} as const

const RECENT_DAYS = 90
const PREFETCH_THREADS = 50
const DAY = 24 * 60 * 60 * 1000

/** Enqueue an incremental sync for an account, coalescing bursts of push notifications. */
export const enqueueSync = (db: Db, userId: string, accountId: string) =>
  enqueueJob(db, { userId, kind: JOB.sync, payload: { accountId }, dedupeKey: `sync:${accountId}` })

/** Re-splits every inbox thread after the user's split rules change; bursts coalesce. */
export const enqueueResplit = (db: Db, userId: string) =>
  enqueueJob(db, { userId, kind: JOB.splits, dedupeKey: `splits:${userId}` })

/** Renews the account's push watch now (Graph lifecycle events ask for this). */
export const enqueueWatchNow = (db: Db, userId: string, accountId: string) =>
  enqueueJob(db, {
    userId,
    kind: JOB.watch,
    payload: { accountId },
    dedupeKey: `watch-now:${accountId}`,
  })

/** Starts the first sync of a freshly connected account. */
export const enqueueInitialSync = (db: Db, userId: string, accountId: string) =>
  enqueueJob(db, {
    userId,
    kind: JOB.backfill,
    payload: { accountId, cursor: null, window: 'recent' },
    dedupeKey: `backfill:${accountId}:recent:start`,
  })

export function createHandlers(deps: {
  db: Db
  providers: ProviderFactory
  config: EngineConfig
  /** Defaults to Supabase Storage from config, when configured. */
  storage?: Storage
  /** Defaults to a Claude client from config.ai; AI jobs are skipped while neither is set. */
  ai?: Ai
  /** Web Push delivery; notifications are skipped while VAPID keys are unset. */
  push?: PushSender
}): Record<string, Handler> {
  const { db, providers, config } = deps
  const storage = deps.storage ?? (config.storage ? new Storage(config.storage) : undefined)
  const ai = deps.ai ?? (config.ai ? createAi(config.ai) : undefined)
  /** New mail gets triaged once it has landed; a no-op while AI is off. */
  const afterNewMail = (account: AccountRecord) =>
    ai ? enqueueTriage(db, account.userId, account.id) : Promise.resolve()

  /** Runs fn with the account loaded; auth failures park the account for reconnecting. */
  const withAccount = async (job: JobLike, fn: (a: AccountRecord) => Promise<void>) => {
    const account = await getAccount(db, String(job.payload.accountId))
    if (!account || account.status === 'disabled') return
    try {
      await fn(account)
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await updateAccount(db, account.id, { status: 'needs_reauth', lastError: err.message })
        await nudge(db, account.userId)
        return
      }
      throw err
    }
  }

  return {
    async [JOB.backfill](job) {
      await withAccount(job, async (account) => {
        const provider = providers.forAccount(account)
        const window = job.payload.window === 'older' ? 'older' : 'recent'
        const cursor = (job.payload.cursor as string | null) ?? null

        if (window === 'recent' && !cursor) {
          // Mark where incremental sync resumes, so mail arriving mid-backfill is not missed.
          await updateAccount(db, account.id, {
            status: 'backfilling',
            syncState: await provider.initialState(),
          })
        }

        const page = await provider.backfillPage(
          cursor,
          window === 'recent' ? { sinceDays: RECENT_DAYS } : { beforeDays: RECENT_DAYS },
        )
        const { changed } = await applySyncBatch(db, {
          userId: account.userId,
          accountId: account.id,
          batch: page.batch,
        })
        if (changed) {
          await nudge(db, account.userId)
          if (window === 'recent') await afterNewMail(account)
        }

        if (page.cursor) {
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.backfill,
            payload: { accountId: account.id, cursor: page.cursor, window },
            dedupeKey: `backfill:${account.id}:${window}:${page.cursor}`,
          })
        } else if (window === 'recent') {
          await updateAccount(db, account.id, {
            status: 'active',
            lastSyncedAt: new Date(),
            lastError: null,
          })
          await nudge(db, account.userId)
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.watch,
            payload: { accountId: account.id },
          })
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.prefetch,
            payload: { accountId: account.id },
          })
          await enqueueSync(db, account.userId, account.id)
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.backfill,
            payload: { accountId: account.id, cursor: null, window: 'older' },
            dedupeKey: `backfill:${account.id}:older:start`,
            runAt: new Date(Date.now() + 60_000),
          })
        } else {
          await markMirrorComplete(db, account.id)
        }
      })
    },

    async [JOB.sync](job) {
      await withAccount(job, async (account) => {
        // No cursor yet means the first backfill hasn't started; it enqueues a sync when done.
        if (!Object.keys(account.syncState).length) return
        const provider = providers.forAccount(account)
        const r = await provider.incremental(account.syncState)
        if (r.resyncRequired) {
          await updateAccount(db, account.id, { syncState: await provider.initialState() })
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.backfill,
            payload: { accountId: account.id, cursor: null, window: 'recent' },
            dedupeKey: `backfill:${account.id}:recent:start`,
          })
          return
        }
        const { changed, inserted } = await applySyncBatch(db, {
          userId: account.userId,
          accountId: account.id,
          batch: r.batch,
        })
        // Only incremental sync notifies: backfills replay history, not news.
        if (inserted.length && deps.push) await enqueueNotify(db, account.userId, inserted)
        const recovered = account.status === 'needs_reauth' || account.status === 'error'
        await updateAccount(db, account.id, {
          syncState: r.next,
          lastSyncedAt: new Date(),
          lastError: null,
          ...(recovered ? { status: 'active' } : {}),
        })
        // Ops parked while the account was unreachable can go now.
        if (recovered) await enqueueOutboxFlush(db, account.userId, account.id)
        // A capped first pass (Outlook folder deltas) carries on in the next job.
        if (r.more) await enqueueSync(db, account.userId, account.id)
        if (changed) {
          await rearchiveMuted(db, account.userId, account.id)
          await afterNewMail(account)
          await enqueueJob(db, {
            userId: account.userId,
            kind: JOB.prefetch,
            payload: { accountId: account.id },
            dedupeKey: `prefetch:${account.id}`,
          })
        }
        await nudge(db, account.userId)
      })
    },

    async [JOB.watch](job) {
      await withAccount(job, async (account) => {
        if (!canWatch(config, account)) return
        const provider = providers.forAccount(account)
        const w = await provider.watch(account.syncState)
        await updateAccount(db, account.id, {
          syncState: { ...w.state, watchExpiresAt: w.expiresAt.getTime() },
        })
        // Graph drops notifications now and then; a daily sync catches whatever was missed.
        if (account.provider === 'graph') await enqueueSync(db, account.userId, account.id)
        // Watches last days (Gmail 7, Graph 3); renew daily so one failure never lets one lapse.
        await enqueueJob(db, {
          userId: account.userId,
          kind: JOB.watch,
          payload: { accountId: account.id },
          dedupeKey: `watch:${account.id}`,
          runAt: new Date(Date.now() + DAY),
        })
      })
    },

    async [JOB.splits](job) {
      // Clients evaluate the same rules locally the moment they change; this keeps the
      // stored split (notifications, badges) in step.
      await db.transaction((tx) => recomputeSplits(tx, job.userId, null))
    },

    async [JOB.notify](job) {
      if (!deps.push) return
      const ids = job.payload.messageIds
      if (Array.isArray(ids)) await notifyNewMail(db, deps.push, job.userId, ids.map(String))
    },

    async [JOB.notifyTest](job) {
      if (deps.push) await sendTestNotification(db, deps.push, job.userId)
    },

    async [JOB.outbox](job) {
      await withAccount(job, async (account) => {
        if (account.status === 'needs_reauth') return
        await flushOutbox(
          db,
          account,
          providers.forAccount(account),
          () => enqueueSync(db, account.userId, account.id),
          storage,
        )
      })
    },

    async [JOB.draft](job) {
      const [row] = await db.query<{ account_id: string }>(
        `SELECT account_id FROM drafts WHERE id = $1`,
        [job.payload.draftId],
      )
      if (!row) return
      await withAccount({ ...job, payload: { accountId: row.account_id } }, (account) =>
        syncDraft(db, String(job.payload.draftId), providers.forAccount(account), storage),
      )
    },

    async [JOB.wake]() {
      await runWakeups(db)
    },

    async [JOB.triage](job) {
      if (!ai) return
      await withAccount(job, async (account) => {
        await triageAccount(db, ai, account)
      })
    },

    async [JOB.prefetch](job) {
      await withAccount(job, async (account) => {
        const missing = await db.query<{ id: string }>(
          `SELECT m.id FROM messages m
           JOIN (
             SELECT t.id FROM threads t
             JOIN thread_folders tf ON tf.thread_id = t.id
             JOIN folders f ON f.id = tf.folder_id AND f.kind = 'inbox'
             WHERE t.account_id = $1
             ORDER BY t.last_message_at DESC LIMIT $2
           ) recent ON recent.id = m.thread_id
           WHERE m.body_status = 'none'`,
          [account.id, PREFETCH_THREADS],
        )
        if (!missing.length) return
        await mapLimit(missing, 4, (m) =>
          getMessageBody(db, providers, config.imageProxySecret, account.userId, m.id),
        )
        // Body status flips are message updates the clients should see.
        await db.query(
          `INSERT INTO changes (user_id, entity, entity_id, op) SELECT $1, 'message', unnest($2::text[]), 'upsert'`,
          [account.userId, missing.map((m) => m.id)],
        )
        await nudge(db, account.userId)
      })
    },
  }
}
