import type { PushPayload } from '@zachhub/core'
import type { DeviceRow } from '@zachhub/db/server'
import webpush from 'web-push'
import type { PushSender } from './notify'

export interface VapidConfig {
  publicKey: string
  privateKey: string
  /** mailto: or https: contact the push services can reach. */
  subject: string
}

/** VAPID keys from the worker's env (`npx web-push generate-vapid-keys`); null when unset. */
export function vapidFromEnv(env: Record<string, string | undefined> = process.env) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return null
  return {
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT ?? 'https://mail.zachconrad.dev',
  }
}

/**
 * Web Push (RFC 8030/8291) via the `web-push` package. Kept out of the engine index so the
 * API bundle, which never sends, doesn't carry it. High urgency so phones and sleeping
 * laptops deliver at once; a short TTL because a banner for hour-old mail is noise.
 */
export function webPushSender(vapid: VapidConfig): PushSender {
  const options = {
    vapidDetails: vapid,
    TTL: 60 * 60,
    urgency: 'high' as const,
    timeout: 10_000,
  }
  return {
    async send(device: DeviceRow, payload: PushPayload) {
      if (!device.keys) return 'gone'
      // Replies to the same thread replace a queued, undelivered push (topic: ≤32 url-safe chars).
      const topic =
        payload.notices.length === 1 ? payload.notices[0]!.threadId.replaceAll('-', '') : null
      try {
        await webpush.sendNotification(
          { endpoint: device.token, keys: device.keys },
          JSON.stringify(payload),
          topic ? { ...options, topic } : options,
        )
        return 'ok'
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) return 'gone'
        throw err
      }
    },
  }
}
