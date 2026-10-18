import {
  DEFAULT_NOTIFICATION_SETTINGS,
  normalizeVip,
  type AccountRow,
  type NotificationSettings,
  type SplitTab,
} from '@zachhub/core'
import { useEffect, useState } from 'react'
import { useAuth } from '../auth/session'
import { useCommands } from '../lib/useCommands'
import {
  disablePush,
  enablePush,
  getNotificationSettings,
  pushState,
  saveNotificationSettings,
  sendTestNotification,
  type PushState,
} from './push'

const CACHE_KEY = 'zachmail.notificationSettings'

const cached = (): NotificationSettings => {
  try {
    const v = localStorage.getItem(CACHE_KEY)
    return v ? (JSON.parse(v) as NotificationSettings) : DEFAULT_NOTIFICATION_SETTINGS
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS
  }
}

const STATE_TEXT: Record<PushState, string> = {
  unsupported: 'This browser cannot receive push notifications.',
  desktop: 'The Mac app shows its own notifications for Important mail.',
  blocked: 'Notifications are blocked for this site in the browser settings.',
  off: 'Off in this browser.',
  on: 'On in this browser.',
}

/**
 * Settings → Notifications (design §3.9). Rules live on the server (the worker applies them
 * to every new message); this browser's subscription is managed here too. Renders from the
 * last saved copy at once and refreshes in the background.
 */
export default function NotificationSettingsPane({
  tabs,
  accounts,
  onClose,
}: {
  tabs: readonly SplitTab[]
  accounts: readonly AccountRow[]
  onClose: () => void
}) {
  const auth = useAuth()
  const token = auth.status === 'signedIn' ? (auth.session?.access_token ?? null) : null
  const [settings, setSettings] = useState(cached)
  const [vipText, setVipText] = useState(() => settings.vips.join('\n'))
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useCommands({ 'nav.back': onClose })

  useEffect(() => {
    let live = true
    void pushState().then((s) => live && setState(s))
    void getNotificationSettings(token).then(
      (s) => {
        if (!live) return
        setSettings(s)
        setVipText(s.vips.join('\n'))
        localStorage.setItem(CACHE_KEY, JSON.stringify(s))
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [token])

  const save = (next: NotificationSettings) => {
    setSettings(next)
    setError(null)
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
    void saveNotificationSettings(token, next).catch((e: Error) => setError(e.message))
  }

  const run = async (fn: () => Promise<PushState | unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const r = await fn()
      if (typeof r === 'string') setState(r as PushState)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (list: string[], key: string, on: boolean) =>
    on ? [...new Set([...list, key])] : list.filter((k) => k !== key)

  const saveVips = () => {
    const lines = vipText
      .split(/[\n,]/)
      .map((l) => l.trim())
      .filter(Boolean)
    const vips = lines.map(normalizeVip)
    const bad = lines.filter((_, i) => !vips[i])
    if (bad.length) return setError(`Not an address or domain: ${bad.join(', ')}`)
    const clean = [...new Set(vips as string[])]
    setVipText(clean.join('\n'))
    if (clean.join() !== settings.vips.join()) save({ ...settings, vips: clean })
  }

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div
        className="notify-settings"
        role="dialog"
        aria-label="Notification settings"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="section-label">Notifications</h2>

        <section className="notify-row">
          <span className="muted">{state ? STATE_TEXT[state] : ' '}</span>
          <span className="spacer" />
          {state === 'off' && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => run(() => enablePush(token))}
            >
              Turn on
            </button>
          )}
          {state === 'on' && (
            <>
              <button
                className="btn"
                disabled={busy}
                onClick={() => run(() => sendTestNotification(token))}
              >
                Send test
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => disablePush(token))}>
                Turn off
              </button>
            </>
          )}
        </section>

        <label className="notify-check">
          <input
            type="checkbox"
            checked={!settings.enabled}
            onChange={(e) => save({ ...settings, enabled: !e.target.checked })}
          />
          Pause all notifications
        </label>

        <fieldset className="notify-group" disabled={!settings.enabled}>
          <legend className="section-label">Notify for new mail in</legend>
          {tabs.map((t) => (
            <label className="notify-check" key={t.key}>
              <input
                type="checkbox"
                checked={settings.splits.includes(t.key)}
                onChange={(e) =>
                  save({ ...settings, splits: toggle(settings.splits, t.key, e.target.checked) })
                }
              />
              {t.label}
            </label>
          ))}
        </fieldset>

        <fieldset className="notify-group" disabled={!settings.enabled}>
          <legend className="section-label">VIPs</legend>
          <p className="rules-hint muted">
            Always notify for these senders, whatever split they land in. One address or domain per
            line.
          </p>
          <textarea
            className="notify-vips"
            rows={4}
            value={vipText}
            placeholder={'mom@family.org\nstripe.com'}
            onChange={(e) => setVipText(e.target.value)}
            onBlur={saveVips}
          />
        </fieldset>

        {accounts.length > 1 && (
          <fieldset className="notify-group" disabled={!settings.enabled}>
            <legend className="section-label">Accounts</legend>
            {accounts.map((a) => (
              <label className="notify-check" key={a.id}>
                <input
                  type="checkbox"
                  checked={!settings.mutedAccounts.includes(a.id)}
                  onChange={(e) =>
                    save({
                      ...settings,
                      mutedAccounts: toggle(settings.mutedAccounts, a.id, !e.target.checked),
                    })
                  }
                />
                {a.email}
              </label>
            ))}
          </fieldset>
        )}

        {error && <p className="notify-error">{error}</p>}
        <div className="rules-actions">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
