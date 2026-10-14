import type { AccountRow } from '@zachmail/core'
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '../auth/session'
import { demoMode, supabase } from '../lib/supabase'
import { DataClient } from './client'
import { ThreadCache } from './threadCache'
import { Triage } from './triage'
import { useDesktopUnread } from './useDesktopUnread'

interface Data {
  client: DataClient
  threads: ThreadCache
  triage: Triage
  accounts: Map<string, AccountRow>
  ownEmails: Set<string>
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
    return { client, threads: new ThreadCache(client), triage: new Triage(client) }
  })
  const { client } = base
  const [accounts, setAccounts] = useState<Map<string, AccountRow>>(new Map())

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
    load()
    const off = client.subscribe((e) => e.type === 'changed' && load())
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
    }),
    [base, accounts],
  )

  useDesktopUnread(client, value.ownEmails)

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>
}
