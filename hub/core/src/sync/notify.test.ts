import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  InvalidHubNoticeError,
  InvalidNotificationSettingsError,
  compileNotifyRules,
  isAppPath,
  isVip,
  normalizeVip,
  parseHubNotice,
  parseNotificationSettings,
  type NotificationSettings,
  type NotifyCandidate,
} from './notify'

const ACC = '4b7a1c1e-0000-4000-8000-0000000000aa'

const candidate = (over: Partial<NotifyCandidate> = {}): NotifyCandidate => ({
  accountId: ACC,
  split: 'important',
  fromEmail: 'ana@example.com',
  muted: false,
  unread: true,
  ...over,
})

const rules = (over: Partial<NotificationSettings> = {}) =>
  compileNotifyRules({ ...DEFAULT_NOTIFICATION_SETTINGS, ...over })

describe('compileNotifyRules', () => {
  it('notifies only the Important split by default', () => {
    const test = rules()
    expect(test(candidate())).toBe(true)
    expect(test(candidate({ split: 'other' }))).toBe(false)
    expect(test(candidate({ split: 'newsletters' }))).toBe(false)
  })

  it('never notifies read, muted, out-of-inbox or disabled mail', () => {
    expect(rules()(candidate({ unread: false }))).toBe(false)
    expect(rules()(candidate({ muted: true }))).toBe(false)
    expect(rules()(candidate({ split: null }))).toBe(false)
    expect(rules({ enabled: false })(candidate())).toBe(false)
  })

  it('lets VIPs through from any split, but not from a muted account', () => {
    const test = rules({ vips: ['@stripe.com', 'mom@family.org'] })
    expect(test(candidate({ split: 'notifications', fromEmail: 'billing@mail.stripe.com' }))).toBe(
      true,
    )
    expect(test(candidate({ split: 'other', fromEmail: 'Mom@Family.org' }))).toBe(true)
    expect(test(candidate({ split: 'other', fromEmail: 'dad@family.org' }))).toBe(false)
    expect(
      rules({ vips: ['@stripe.com'], mutedAccounts: [ACC] })(
        candidate({ fromEmail: 'x@stripe.com' }),
      ),
    ).toBe(false)
  })

  it('notifies custom splits by rule id', () => {
    const test = rules({ splits: ['important', 'rule-1'] })
    expect(test(candidate({ split: 'rule-1' }))).toBe(true)
  })
})

describe('VIPs', () => {
  it('normalizes addresses and domains', () => {
    expect(normalizeVip(' Ana@Example.com ')).toBe('ana@example.com')
    expect(normalizeVip('stripe.com')).toBe('@stripe.com')
    expect(normalizeVip('@Stripe.com')).toBe('@stripe.com')
    expect(normalizeVip('nope')).toBeNull()
    expect(normalizeVip('a@')).toBeNull()
    expect(normalizeVip('a b@c.com')).toBeNull()
  })

  it('matches subdomains but not lookalikes', () => {
    expect(isVip(['@stripe.com'], 'x@stripe.com')).toBe(true)
    expect(isVip(['@stripe.com'], 'x@eu.stripe.com')).toBe(true)
    expect(isVip(['@stripe.com'], 'x@notstripe.com')).toBe(false)
    expect(isVip(['@stripe.com'], null)).toBe(false)
  })
})

describe('parseNotificationSettings', () => {
  it('normalizes and dedupes', () => {
    expect(
      parseNotificationSettings({
        enabled: true,
        splits: ['important', 'important'],
        vips: ['Ana@x.com', 'ana@x.com', 'stripe.com'],
        mutedAccounts: [ACC.toUpperCase()],
      }),
    ).toEqual({
      enabled: true,
      splits: ['important'],
      vips: ['ana@x.com', '@stripe.com'],
      mutedAccounts: [ACC],
    })
  })

  it('rejects bad input', () => {
    const ok = { enabled: true, splits: [], vips: [], mutedAccounts: [] }
    for (const bad of [
      null,
      { ...ok, enabled: 'yes' },
      { ...ok, splits: 'important' },
      { ...ok, vips: ['not an address'] },
      { ...ok, mutedAccounts: ['acc'] },
      { ...ok, splits: [''] },
    ])
      expect(() => parseNotificationSettings(bad)).toThrow(InvalidNotificationSettingsError)
  })
})

describe('parseHubNotice', () => {
  const ok = { kind: 'tasks.alert', title: ' Pay rent ', body: '', deepLink: '/tasks/t1?x=1' }

  it('keeps a valid notice, tag optional', () => {
    expect(parseHubNotice(ok)).toEqual({ ...ok, title: 'Pay rent' })
    expect(parseHubNotice({ ...ok, tag: 't1', extra: 1 })).toEqual({
      ...ok,
      title: 'Pay rent',
      tag: 't1',
    })
  })

  it('rejects bad input', () => {
    for (const bad of [
      null,
      { ...ok, kind: 'alert' },
      { ...ok, kind: 'Tasks.alert' },
      { ...ok, title: '  ' },
      { ...ok, body: null },
      { ...ok, deepLink: 'https://evil.example/' },
      { ...ok, tag: '' },
      { ...ok, tag: 7 },
    ])
      expect(() => parseHubNotice(bad)).toThrow(InvalidHubNoticeError)
  })

  it('takes same-origin app paths only', () => {
    expect(isAppPath('/inbox/important?thread=a#b')).toBe(true)
    for (const p of ['', 'tasks/1', '//evil.example', '/\\evil.example', '/a b', 'javascript:x'])
      expect(isAppPath(p)).toBe(false)
  })
})
