import type { AccountRow, SnippetRow, SplitRuleRow } from '@zachmail/core'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/session'
import { demoMode, supabase } from '../lib/supabase'
import { DataClient } from './client'
import { ThreadCache } from './threadCache'
import { Triage } from './triage'
import { ComposeStore } from '../compose/store'
import { useDesktopUnread } from './useDesktopUnread'

interface Data {
  client: DataClient
  threads: ThreadCache
  triage: Triage
  compose: ComposeStore
  accounts: Map<string, AccountRow>
  ownEmails: Set<string>
  /** Split rules as the replica sees them (local edits included); null until first read. */
  splitRules: SplitRuleRow[] | null
  /** Saves (rule) or deletes (null) a split rule; tabs update this frame, lists follow. */
  editSplitRule: (id: string, rule: SplitRuleRow | null) => void
  /** Snippets as the replica sees them (local edits included), by name. */
  snippets: SnippetRow[]
  /** Saves (snippet) or deletes (null) a snippet; shows this frame, syncs after. */
  editSnippet: (id: string, snippet: SnippetRow | null) => void
}

const DataContext = createContext<Data | null>(null)

export const useData = () => useContext(DataContext)!

function demoThreads(): number {
  const n = Number(new URLSearchParams(location.search).get('demo'))
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 20_000
}

/** Owns the data worker for a signed-in session and keeps it synced. */
export function DataProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const session = auth.status === 'signedIn' ? auth.session : null
  const token = session?.access_token ?? null
  const userId = session?.user.id ?? null

  const [base] = useState(() => {
    const client = new DataClient(
      demoMode ? { mode: 'demo', threads: demoThreads() } : { mode: 'live', apiBase: '', token },
    )
    return {
      client,
      threads: new ThreadCache(client),
      triage: new Triage(client),
      compose: new ComposeStore(client),
    }
  })
  const { client } = base
  const [accounts, setAccounts] = useState<Map<string, AccountRow>>(new Map())
  const [splitRules, setSplitRules] = useState<SplitRuleRow[] | null>(null)
  const [snippets, setSnippets] = useState<SnippetRow[]>([])

  useEffect(() => {
    client.retain()
    // Free the OPFS handles promptly so a reload's new worker can open the database.
    const unload = () => client.terminate()
    const restore = (e: PageTransitionEvent) => e.persisted && location.reload()
    window.addEventListener('pagehide', unload)
    window.addEventListener('pageshow', restore)
    return () => {
      window.removeEventListener('pagehide', unload)
      window.removeEventListener('pageshow', restore)
      client.release()
    }
  }, [client])
  useEffect(() => client.setToken(token), [client, token])

  // Pull when the app regains focus (architecture §6).
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === 'visible') client.nudge()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [client])

  // Supabase Realtime nudge: the server broadcasts `changed` on user:<uid> after each write.
  useEffect(() => {
    if (!supabase || !userId) return
    const sb = supabase
    const channel = sb.channel(`user:${userId}`, { config: { private: true } })
    void sb.realtime
      .setAuth()
      .then(() => channel.on('broadcast', { event: 'changed' }, () => client.nudge()).subscribe())
    return () => void sb.removeChannel(channel)
  }, [client, userId])

  useEffect(() => {
    let cancelled = false
    let last = ''
    const load = () =>
      void client.api.accounts().then((rows) => {
        const key = JSON.stringify(rows)
        if (cancelled || key === last) return
        last = key
        setAccounts(new Map(rows.map((a) => [a.id, a])))
      })
    const loadRules = () =>
      void client.api.splitRules().then((rows) => {
        if (cancelled) return
        const key = JSON.stringify(rows)
        setSplitRules((prev) => (JSON.stringify(prev) === key ? prev : rows))
      })
    const loadSnippets = () =>
      void client.api.snippets().then((rows) => {
        if (cancelled) return
        const key = JSON.stringify(rows)
        setSnippets((prev) => (JSON.stringify(prev) === key ? prev : rows))
      })
    load()
    loadRules()
    loadSnippets()
    const off = client.subscribe((e) => {
      if (e.type !== 'changed') return
      load()
      loadRules()
      loadSnippets()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [client])

  const value = useMemo<Data>(
    () => ({
      ...base,
      accounts,
      ownEmails: new Set([...accounts.values()].map((a) => a.email.toLowerCase())),
      splitRules,
      editSplitRule: (id, rule) => {
        setSplitRules((rs) => {
          const rest = (rs ?? []).filter((r) => r.id !== id)
          return rule ? [...rest, rule] : rest
        })
        base.client.editSplitRule(id, rule)
      },
      snippets,
      editSnippet: (id, snippet) => {
        setSnippets((rs) => {
          const rest = rs.filter((r) => r.id !== id)
          return snippet ? [...rest, snippet].sort((a, b) => a.name.localeCompare(b.name)) : rest
        })
        base.client.editSnippet(id, snippet)
      },
    }),
    [base, accounts, splitRules, snippets],
  )

  useDesktopUnread(client, value.ownEmails)

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}
