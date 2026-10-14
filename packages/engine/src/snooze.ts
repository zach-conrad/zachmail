import { nudge, wakeDue, type Db } from '@zachmail/db/server'
import { enqueueOutboxFlush } from './outbox'

/**
 * Brings due snoozes and reminders back: the wake ops go through the outbox like any other
 * (move to inbox and mark unread at the provider), and clients are nudged to pull. Runs from
 * the timed wake job and from the worker's minute sweep.
 */
export async function runWakeups(db: Db) {
  for (;;) {
    const results = await wakeDue(db)
    for (const r of results) {
      for (const accountId of r.accounts) await enqueueOutboxFlush(db, r.userId, accountId)
      if (r.accepted.length) await nudge(db, r.userId)
    }
    // wakeDue takes a bounded batch; keep going until nothing is due.
    if (!results.some((r) => r.accepted.length)) return
  }
}
