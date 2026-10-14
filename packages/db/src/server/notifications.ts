import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '@zachmail/core'
import type { Queryable } from './sql'

export async function readNotificationSettings(
  db: Queryable,
  userId: string,
): Promise<NotificationSettings> {
  const [row] = await db.query<NotificationSettings>(
    `SELECT enabled, splits, vips, muted_accounts AS "mutedAccounts"
     FROM notification_settings WHERE user_id = $1`,
    [userId],
  )
  return row ?? { ...DEFAULT_NOTIFICATION_SETTINGS }
}

export async function saveNotificationSettings(
  db: Queryable,
  userId: string,
  s: NotificationSettings,
): Promise<void> {
  await db.query(
    `INSERT INTO notification_settings (user_id, enabled, splits, vips, muted_accounts)
     VALUES ($1, $2, $3::text[], $4::text[], $5::text[])
     ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, splits = excluded.splits,
       vips = excluded.vips, muted_accounts = excluded.muted_accounts, updated_at = now()`,
    [userId, s.enabled, s.splits, s.vips, s.mutedAccounts],
  )
}

export interface DeviceRow {
  id: string
  kind: 'webpush' | 'apns'
  token: string
  keys: { p256dh: string; auth: string } | null
  label: string | null
}

/**
 * Registers (or refreshes) a push target. A token already registered to another user is
 * left alone and reported as false.
 */
export async function upsertDevice(
  db: Queryable,
  userId: string,
  d: Omit<DeviceRow, 'id'>,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO devices (user_id, kind, token, keys, label) VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (token) DO UPDATE SET keys = excluded.keys, label = excluded.label,
       kind = excluded.kind, last_seen_at = now()
     WHERE devices.user_id = excluded.user_id
     RETURNING id`,
    [userId, d.kind, d.token, d.keys, d.label],
  )
  return rows.length > 0
}

export async function deleteDevice(db: Queryable, userId: string, token: string) {
  await db.query(`DELETE FROM devices WHERE user_id = $1 AND token = $2`, [userId, token])
}

export async function listDevices(
  db: Queryable,
  userId: string,
  kind: DeviceRow['kind'],
): Promise<DeviceRow[]> {
  return db.query<DeviceRow>(
    `SELECT id::text AS id, kind, token, keys, label FROM devices WHERE user_id = $1 AND kind = $2`,
    [userId, kind],
  )
}

/** Drops targets the push service says are gone (404/410). */
export async function deleteDevicesById(db: Queryable, ids: string[]) {
  if (ids.length) await db.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [ids])
}

export interface NotifyMessageRow {
  messageId: string
  threadId: string
  accountId: string
  /** The thread's split now (null when it is not in the inbox). */
  split: string | null
  muted: boolean
  unread: boolean
  /** Sender address, lowercased. */
  fromEmail: string | null
  fromName: string | null
  subject: string
  snippet: string
  date: number
}

/**
 * The facts notification rules need about freshly ingested messages, newest first. Messages
 * Zach sent himself (from any connected account) and messages older than `maxAgeMs` are left
 * out: a catch-up sync after downtime should not replay a morning of banners.
 */
export async function readNotifyMessages(
  db: Queryable,
  userId: string,
  messageIds: string[],
  maxAgeMs: number,
): Promise<NotifyMessageRow[]> {
  if (!messageIds.length) return []
  const rows = await db.query<Omit<NotifyMessageRow, 'date'> & { date: Date | string }>(
    `SELECT m.id::text AS "messageId", m.thread_id::text AS "threadId",
       m.account_id::text AS "accountId", t.split, t.muted, m.unread,
       lower(m."from"->>'email') AS "fromEmail", m."from"->>'name' AS "fromName",
       COALESCE(m.subject, '') AS subject, COALESCE(m.snippet, '') AS snippet, m.date
     FROM messages m JOIN threads t ON t.id = m.thread_id
     WHERE m.user_id = $1 AND m.id = ANY($2::uuid[])
       AND m.date > now() - make_interval(secs => $3)
     ORDER BY m.date DESC`,
    [userId, messageIds, maxAgeMs / 1000],
  )
  const own = new Set(
    (
      await db.query<{ email: string }>(
        `SELECT lower(email) AS email FROM accounts WHERE user_id = $1`,
        [userId],
      )
    ).map((r) => r.email),
  )
  return rows
    .filter((r) => !r.fromEmail || !own.has(r.fromEmail))
    .map((r) => ({ ...r, date: new Date(r.date).getTime() }))
}

/** Unread threads in the Important split: the app badge (design §3.9). */
export async function importantUnreadCount(db: Queryable, userId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM threads WHERE user_id = $1 AND split = 'important' AND unread`,
    [userId],
  )
  return row?.n ?? 0
}
