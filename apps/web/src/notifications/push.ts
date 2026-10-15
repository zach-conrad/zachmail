import type { NotificationSettings } from '@zachhub/core'
import { desktop } from '../lib/desktop'

/**
 * Web Push on the main thread. Nothing here runs on the click path: the service worker is
 * registered after first paint, and only once Zach has granted permission.
 */

export type PushState = 'unsupported' | 'desktop' | 'blocked' | 'off' | 'on'

const SW_URL = '/sw.js'

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

async function api<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) {
    const msg = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
    throw new Error(msg ?? `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

const registration = () => navigator.serviceWorker.register(SW_URL, { scope: '/' })

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function label() {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Mac/.test(ua)
      ? 'macOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Android/.test(ua)
          ? 'Android'
          : 'Linux'
  return `${browser} on ${os}`
}

const register = (token: string | null, sub: PushSubscription) =>
  api(token, '/devices', {
    method: 'PUT',
    body: JSON.stringify({ kind: 'webpush', subscription: sub.toJSON(), label: label() }),
  })

export async function pushState(): Promise<PushState> {
  if (desktop) return 'desktop'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  if (Notification.permission !== 'granted') return 'off'
  const reg = await navigator.serviceWorker.getRegistration(SW_URL)
  return (await reg?.pushManager.getSubscription()) ? 'on' : 'off'
}

/** Asks for permission (must run from a click), subscribes this browser and registers it. */
export async function enablePush(token: string | null): Promise<PushState> {
  if (desktop) return 'desktop'
  if (!pushSupported()) return 'unsupported'
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked'
  const { key } = await api<{ key: string }>(token, '/push/key')
  const reg = await registration()
  await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key),
    }))
  await register(token, sub)
  return 'on'
}

export async function disablePush(token: string | null): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration(SW_URL)
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api(token, '/devices', {
      method: 'DELETE',
      body: JSON.stringify({ token: sub.endpoint }),
    })
    await sub.unsubscribe()
  }
  return 'off'
}

/**
 * On launch, after first paint: keeps the service worker current and re-registers the
 * subscription (browsers rotate endpoints; the server drops ones that went dead).
 */
export async function refreshPush(token: string | null) {
  if (desktop || !pushSupported() || Notification.permission !== 'granted') return
  const reg = await registration()
  const sub = await reg.pushManager.getSubscription()
  if (sub) await register(token, sub)
}

/** Clears banners for a thread once it is read here. */
export async function clearThreadNotifications(threadId: string) {
  if (!('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.getRegistration(SW_URL)
  for (const n of (await reg?.getNotifications({ tag: threadId })) ?? []) n.close()
}

export const getNotificationSettings = (token: string | null) =>
  api<NotificationSettings>(token, '/notification-settings')

export const saveNotificationSettings = (token: string | null, s: NotificationSettings) =>
  api<NotificationSettings>(token, '/notification-settings', {
    method: 'PUT',
    body: JSON.stringify(s),
  })

export const sendTestNotification = (token: string | null) =>
  api(token, '/notifications/test', { method: 'POST' })
