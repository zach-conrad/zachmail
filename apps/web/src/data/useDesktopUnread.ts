import { useEffect } from 'react'
import { desktop } from '../lib/desktop'
import { senderLabel } from '../lib/format'
import type { DataClient } from './client'

const IMPORTANT = { split: 'important' } as const
const MAX_BANNERS = 3

/**
 * macOS only: keeps the Dock badge at the Important split's unread count and posts a
 * notification for Important mail that arrives while the app is open.
 */
export function useDesktopUnread(client: DataClient, ownEmails: ReadonlySet<string>) {
  useEffect(() => {
    if (!desktop) return
    const bridge = desktop
    // Mail older than launch (the bootstrap backlog) never notifies.
    let since = Date.now()
    let running = false
    let again = false
    const check = async () => {
      if (running) return void (again = true)
      running = true
      try {
        do {
          again = false
          const { count, fresh } = await client.api.unread(IMPORTANT, since, MAX_BANNERS + 1)
          bridge.setUnreadCount(count)
          if (!fresh.length) continue
          since = Math.max(since, ...fresh.map((t) => t.lastMessageAt))
          if (fresh.length > MAX_BANNERS) {
            bridge.notify({ title: 'New mail', body: `${fresh.length}+ new important threads` })
          } else {
            for (const t of fresh)
              bridge.notify({
                title: senderLabel(t.participants, ownEmails),
                body: t.subject,
                threadId: t.id,
              })
          }
        } while (again)
      } finally {
        running = false
      }
    }
    void check()
    return client.subscribe((e) => e.type === 'changed' && void check())
  }, [client, ownEmails])
}
