import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef } from 'react'
import { useAuth } from '../auth/session'
import type { DataClient } from '../data/client'
import { refreshPush } from './push'

type SwMessage =
  | { type: 'zachmail:push' }
  | { type: 'zachmail:open'; threadId?: string; split?: string }
  | { type: 'zachmail:navigate'; path?: string }

/**
 * Connects the service worker to the open app: a push pulls the replica at once, and a
 * notification click opens its thread (or a hub notice's deep link) here instead of in a new
 * window.
 */
export function usePushBridge(client: DataClient, open: (threadId: string, split: string) => void) {
  const auth = useAuth()
  const router = useRouter()
  const token = auth.status === 'signedIn' ? (auth.session?.access_token ?? null) : null
  const openRef = useRef(open)
  useEffect(() => {
    openRef.current = open
  })

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent<SwMessage>) => {
      if (e.data?.type === 'zachmail:push') client.nudge()
      else if (e.data?.type === 'zachmail:open' && e.data.threadId)
        openRef.current(e.data.threadId, e.data.split ?? 'important')
      // An app path the service worker checked is same-origin; the router takes it from here.
      else if (e.data?.type === 'zachmail:navigate' && e.data.path?.startsWith('/'))
        router.history.push(e.data.path)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [client, router])

  // Off the startup path: once the browser is idle.
  useEffect(() => {
    if (!token) return
    const run = () => void refreshPush(token).catch(() => {})
    const idle = window.requestIdleCallback?.(run, { timeout: 5000 })
    const timer = idle === undefined ? setTimeout(run, 2000) : undefined
    return () => {
      if (idle !== undefined) window.cancelIdleCallback(idle)
      clearTimeout(timer)
    }
  }, [token])
}
