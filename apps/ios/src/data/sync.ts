/**
 * Keeps the iOS replica fed from the API with the shared sync client (packages/core): bootstrap,
 * then deltas every 60 s and whenever the app comes to the foreground. Bodies are prefetched for
 * the top of the inbox so opening a thread never waits (architecture §1a). Queued triage ops
 * drain to /api/ops after each pull.
 */
import { httpTransport, startSyncLoop, SyncClient } from '@zachmail/core'
import { fetch as expoFetch } from 'expo/fetch'
import { AppState } from 'react-native'
import type { MailStore } from '../mail/store'

export interface SyncConfig {
  /** API origin, e.g. https://mail.zachconrad.dev */
  apiUrl: string
  /** Current Supabase access token; re-read per request so refreshes apply. */
  token: () => Promise<string | null>
}

const PREFETCH = 50

export interface Syncing {
  /** Fetch any bodies an open thread is missing. */
  fetchBodies(threadIds: string[]): void
  stop(): void
}

export function startSync(mail: MailStore, cfg: SyncConfig): Syncing {
  // expo/fetch streams response bodies, which the NDJSON bootstrap needs.
  const transport = httpTransport({
    baseUrl: cfg.apiUrl,
    token: cfg.token,
    fetch: expoFetch as unknown as typeof fetch,
  })
  const inFlight = new Set<string>()
  // Triage ops queued on the phone now go to /api/ops; the server reports them done in deltas.
  mail.useDrain((ops) => transport.ops({ ops }))

  const fetchBodies = (threadIds: string[]) => {
    const want = mail.sql.bodiesMissing(threadIds).filter((m) => !inFlight.has(m.messageId))
    if (!want.length) return
    for (const m of want) inFlight.add(m.messageId)
    void Promise.allSettled(want.map((m) => transport.body(m.messageId))).then((results) => {
      for (const m of want) inFlight.delete(m.messageId)
      const bodies = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      if (bodies.length) {
        mail.sql.putBodies(bodies)
        mail.changed()
      }
    })
  }

  const client = new SyncClient(mail.sql, transport, {
    onChange: () => {
      mail.changed()
      mail.flushOps()
      fetchBodies(mail.inbox(mail.getState(), PREFETCH).map((t) => t.id))
    },
    onError: (err) => console.warn('sync failed', err),
  })
  const stopLoop = startSyncLoop(client, {
    triggers: [
      (pull) => {
        const sub = AppState.addEventListener('change', (s) => s === 'active' && pull())
        return () => sub.remove()
      },
    ],
  })
  return {
    fetchBodies,
    stop() {
      stopLoop()
      client.stop()
    },
  }
}
