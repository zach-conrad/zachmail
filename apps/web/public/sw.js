// ZachHub service worker: Web Push only (no caching; the app shell is served by Vercel).
// Payload contract: PushPayload in hub/core/src/sync/notify.ts.

const ICON = '/favicon.svg'
// Safari revokes subscriptions whose pushes show nothing, so it always gets a banner.
const STRICT = /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent)

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data ? event.data.json() : null))
})

async function handlePush(p) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  // Open tabs pull now instead of waiting for the next nudge.
  for (const c of windows) c.postMessage({ type: 'zachmail:push' })
  if (p && typeof p.badge === 'number' && self.navigator.setAppBadge)
    await self.navigator.setAppBadge(p.badge).catch(() => {})

  if (!p || p.kind === 'test')
    return self.registration.showNotification('ZachHub', {
      body: 'Notifications are on for this browser.',
      icon: ICON,
      tag: 'test',
    })

  // Zach is looking at the app: the list updates by itself.
  if (!STRICT && windows.some((c) => c.focused && c.visibilityState === 'visible')) return

  const shown = p.notices.map((n) =>
    self.registration.showNotification(n.title, {
      body: n.body,
      icon: ICON,
      tag: n.threadId,
      renotify: true,
      timestamp: Date.now(),
      data: { threadId: n.threadId, split: n.split },
    }),
  )
  if (p.more > 0)
    shown.push(
      self.registration.showNotification('ZachHub', {
        body: `${p.more} more new conversation${p.more === 1 ? '' : 's'}`,
        icon: ICON,
        tag: 'more',
        data: { split: 'important' },
      }),
    )
  await Promise.all(shown)
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(openApp(event.notification.data || {}))
})

async function openApp({ threadId, split }) {
  const path = `/inbox/${encodeURIComponent(split || 'important')}`
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const win = windows.find((c) => new URL(c.url).origin === self.location.origin)
  if (win) {
    await win.focus()
    win.postMessage({ type: 'zachmail:open', threadId, split })
    return
  }
  await self.clients.openWindow(threadId ? `${path}?thread=${threadId}` : path)
}
