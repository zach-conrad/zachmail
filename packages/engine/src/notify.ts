import {
  MAX_PUSH_NOTICES,
  compileNotifyRules,
  type PushNotice,
  type PushPayload,
} from '@zachmail/core'
import {
  deleteDevicesById,
  enqueueJob,
  importantUnreadCount,
  listDevices,
  readNotificationSettings,
  readNotifyMessages,
  type Db,
  type DeviceRow,
} from '@zachmail/db/server'
import { mapLimit } from '@zachmail/providers'

export const NOTIFY_JOB = 'notify.push'
export const NOTIFY_TEST_JOB = 'notify.test'

/** Mail older than this when it reaches the mirror (a catch-up after downtime) stays quiet. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000

/** Delivers one payload to one device. 'gone' means the subscription is dead: forget it. */
export interface PushSender {
  send(device: DeviceRow, payload: PushPayload): Promise<'ok' | 'gone'>
}

/** Queued by the sync job for messages new to the mirror; runs right after on LISTEN. */
export const enqueueNotify = (db: Db, userId: string, messageIds: string[]) =>
  enqueueJob(db, { userId, kind: NOTIFY_JOB, payload: { messageIds } })

export const enqueueTestNotification = (db: Db, userId: string) =>
  enqueueJob(db, { userId, kind: NOTIFY_TEST_JOB, dedupeKey: `notify-test:${userId}` })

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

/**
 * Applies the user's notification rules to fresh messages and pushes what passes to every
 * registered browser. One notice per thread (its newest message); a burst beyond
 * MAX_PUSH_NOTICES collapses into a summary. Returns how many devices were sent to.
 */
export async function notifyNewMail(
  db: Db,
  sender: PushSender,
  userId: string,
  messageIds: string[],
): Promise<number> {
  const settings = await readNotificationSettings(db, userId)
  if (!settings.enabled) return 0
  const devices = await listDevices(db, userId, 'webpush')
  if (!devices.length) return 0
  const test = compileNotifyRules(settings)
  const notices: PushNotice[] = []
  const seen = new Set<string>()
  for (const m of await readNotifyMessages(db, userId, messageIds, MAX_AGE_MS)) {
    if (seen.has(m.threadId) || !test(m)) continue
    seen.add(m.threadId)
    notices.push({
      threadId: m.threadId,
      title: m.fromName?.trim() || m.fromEmail || 'New mail',
      body: clip(m.subject ? `${m.subject}\n${m.snippet}` : m.snippet, 180),
      split: m.split!,
    })
  }
  if (!notices.length) return 0
  return deliver(db, sender, devices, {
    v: 1,
    kind: 'mail',
    notices: notices.slice(0, MAX_PUSH_NOTICES),
    more: Math.max(0, notices.length - MAX_PUSH_NOTICES),
    badge: await importantUnreadCount(db, userId),
  })
}

/** "Send test notification" in Settings: proves the whole path, rules aside. */
export async function sendTestNotification(db: Db, sender: PushSender, userId: string) {
  const devices = await listDevices(db, userId, 'webpush')
  return deliver(db, sender, devices, {
    v: 1,
    kind: 'test',
    notices: [],
    more: 0,
    badge: await importantUnreadCount(db, userId),
  })
}

async function deliver(db: Db, sender: PushSender, devices: DeviceRow[], payload: PushPayload) {
  const gone: string[] = []
  let sent = 0
  await mapLimit(devices, 8, async (d) => {
    try {
      if ((await sender.send(d, payload)) === 'gone') gone.push(d.id)
      else sent++
    } catch (err) {
      // One flaky push service must not fail the others; the next mail tries again.
      console.error(JSON.stringify({ msg: 'push failed', device: d.id, error: String(err) }))
    }
  })
  await deleteDevicesById(db, gone)
  return sent
}
