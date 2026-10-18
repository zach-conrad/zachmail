import { isUuid, type SplitKey } from './split'

/**
 * Who gets to interrupt Zach (design §3.9). Default: only the Important split. VIP senders
 * notify from any split; a muted account never notifies, VIPs included. One row per user,
 * edited in Settings → Notifications and read by the worker for every new message.
 */
export interface NotificationSettings {
  enabled: boolean
  /** Split keys that notify: built-in ids or custom split rule ids. */
  splits: string[]
  /** Sender addresses ("ana@x.com") or domains ("@x.com") that always notify. */
  vips: string[]
  /** Account ids that never notify. */
  mutedAccounts: string[]
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  splits: ['important'],
  vips: [],
  mutedAccounts: [],
}

export const NOTIFICATION_LIMITS = { splits: 120, vips: 200, vip: 200, accounts: 50 } as const

/** What the rules look at for one new message. */
export interface NotifyCandidate {
  accountId: string
  /** The thread's split after this message landed; null when it is not in the inbox. */
  split: SplitKey | null
  fromEmail: string | null
  /** Thread muted in ZachMail (its replies get archived). */
  muted: boolean
  unread: boolean
}

/** Normalizes a VIP entry: lowercased address, or "@domain" for a whole domain. */
export function normalizeVip(raw: string): string | null {
  const v = raw.trim().toLowerCase()
  if (!v || v.length > NOTIFICATION_LIMITS.vip || /\s/.test(v)) return null
  const at = v.indexOf('@')
  if (at === -1) return v.includes('.') ? '@' + v : null
  if (at === 0) return v.length > 1 && !v.includes('@', 1) ? v : null
  return at < v.length - 1 && !v.includes('@', at + 1) ? v : null
}

/** True when `email` is a VIP: an exact address, or a listed domain or one of its subdomains. */
export function isVip(vips: readonly string[], email: string | null): boolean {
  if (!email) return false
  const e = email.toLowerCase()
  const host = e.slice(e.lastIndexOf('@') + 1)
  for (const v of vips) {
    if (v[0] === '@') {
      const d = v.slice(1)
      if (host === d || host.endsWith('.' + d)) return true
    } else if (v === e) return true
  }
  return false
}

/** Turns settings into one predicate, once per batch, so per-message checks stay cheap. */
export function compileNotifyRules(s: NotificationSettings): (c: NotifyCandidate) => boolean {
  if (!s.enabled) return () => false
  const splits = new Set(s.splits)
  const muted = new Set(s.mutedAccounts)
  return (c) =>
    c.unread &&
    !c.muted &&
    c.split !== null &&
    !muted.has(c.accountId) &&
    (splits.has(c.split) || isVip(s.vips, c.fromEmail))
}

export class InvalidNotificationSettingsError extends Error {
  override name = 'InvalidNotificationSettingsError'
}

const stringList = (v: unknown, max: number, what: string): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string'))
    throw new InvalidNotificationSettingsError(`${what} must be an array of at most ${max} strings`)
  return v as string[]
}

/** Validates an untrusted PUT /api/notification-settings body. VIPs are normalized and deduped. */
export function parseNotificationSettings(body: unknown): NotificationSettings {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.enabled !== 'boolean')
    throw new InvalidNotificationSettingsError('enabled must be a boolean')
  const splits = stringList(b.splits, NOTIFICATION_LIMITS.splits, 'splits')
  if (splits.some((s) => !s || s.length > 64))
    throw new InvalidNotificationSettingsError('split keys must be 1-64 characters')
  const vips = stringList(b.vips, NOTIFICATION_LIMITS.vips, 'vips').map((v) => {
    const n = normalizeVip(v)
    if (!n) throw new InvalidNotificationSettingsError(`not an address or domain: ${v}`)
    return n
  })
  const mutedAccounts = stringList(b.mutedAccounts, NOTIFICATION_LIMITS.accounts, 'mutedAccounts')
  if (!mutedAccounts.every(isUuid))
    throw new InvalidNotificationSettingsError('mutedAccounts must be account ids')
  return {
    enabled: b.enabled,
    splits: [...new Set(splits)],
    vips: [...new Set(vips)],
    mutedAccounts: [...new Set(mutedAccounts.map((a) => a.toLowerCase()))],
  }
}

// ---- Push payload (worker → service worker / APNs) -------------------------------------------

/** One notification. `threadId` doubles as the tag, so a reply replaces its thread's banner. */
export interface PushNotice {
  threadId: string
  title: string
  body: string
  split: SplitKey
}

/**
 * A notification from any hub module (ZACHHUB_PLAN.md §3): a task alert, a mention. `kind` is
 * namespaced like job kinds ('tasks.alert'); `deepLink` is an app path the click opens; `tag`
 * de-duplicates, so a second notice with the same kind and tag (a task id) replaces the first
 * instead of stacking, and iOS can drop the server copy of an alert it already fired locally.
 */
export interface HubNotice {
  kind: string
  title: string
  body: string
  deepLink: string
  tag?: string
}

export const HUB_NOTICE_LIMITS = { kind: 64, title: 120, body: 400, deepLink: 2048, tag: 128 }

const NOTICE_KIND = /^[a-z][a-z0-9]*\.[a-z0-9][a-z0-9.-]*$/

/** Same-origin app paths only: "/tasks/x", never "//evil.com" or "https://…". */
export const isAppPath = (p: string) =>
  p.length <= HUB_NOTICE_LIMITS.deepLink && /^\/(?![/\\])[^\s\\]*$/.test(p)

export class InvalidHubNoticeError extends Error {
  override name = 'InvalidHubNoticeError'
}

/** Validates a notice from a module or a queued job. Long titles and bodies are the sender's problem. */
export function parseHubNotice(raw: unknown): HubNotice {
  const n = (raw ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof n[k] === 'string' ? (n[k] as string) : null)
  const kind = str('kind')
  if (!kind || kind.length > HUB_NOTICE_LIMITS.kind || !NOTICE_KIND.test(kind))
    throw new InvalidHubNoticeError(`kind must be namespaced like 'tasks.alert'`)
  const title = str('title')?.trim()
  if (!title) throw new InvalidHubNoticeError('title is required')
  const body = str('body')
  if (body === null) throw new InvalidHubNoticeError('body must be a string')
  const deepLink = str('deepLink')
  if (!deepLink || !isAppPath(deepLink))
    throw new InvalidHubNoticeError('deepLink must be an app path like /tasks/123')
  const tag = n.tag === undefined ? undefined : str('tag')
  if (tag === null || (tag !== undefined && (!tag || tag.length > HUB_NOTICE_LIMITS.tag)))
    throw new InvalidHubNoticeError(`tag must be 1-${HUB_NOTICE_LIMITS.tag} characters`)
  return { kind, title, body, deepLink, ...(tag === undefined ? {} : { tag }) }
}

/**
 * The encrypted Web Push body. Mail: `notices` holds at most MAX_PUSH_NOTICES; `more` counts
 * the rest so a burst becomes one summary instead of a wall of banners. Hub: one module notice.
 * `badge` is the Important split's unread count (design §3.9), or null when unknown.
 */
export type PushPayload =
  | { v: 1; kind: 'mail' | 'test'; notices: PushNotice[]; more: number; badge: number | null }
  | { v: 1; kind: 'hub'; notice: HubNotice; badge: number | null }

export const MAX_PUSH_NOTICES = 3
