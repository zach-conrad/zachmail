import { describe, expect, it } from 'vitest'
import { htmlToText, rowTime } from './format'
import { snoozeOptions } from './snooze'
import { classify, isAutomated, splitContext } from './splits'
import { swipeAction } from './swipe'

describe('swipeAction', () => {
  it('maps distance to the design §3.1 verbs', () => {
    expect(swipeAction(10, 400)).toBeNull()
    expect(swipeAction(100, 400)).toBe('done')
    expect(swipeAction(260, 400)).toBe('trash')
    expect(swipeAction(-100, 400)).toBe('snooze')
    expect(swipeAction(-260, 400)).toBe('toggleRead')
  })
})

describe('snoozeOptions', () => {
  it('resolves presets in local time', () => {
    const now = new Date(2026, 9, 13, 10, 0).getTime() // Tuesday 10:00
    const o = Object.fromEntries(snoozeOptions(now).map((x) => [x.id, x.until]))
    expect(o.later).toBe(now + 3 * 3_600_000)
    expect(o.tonight).toBe(new Date(2026, 9, 13, 20).getTime())
    expect(o.tomorrow).toBe(new Date(2026, 9, 14, 8).getTime())
    expect(o.weekend).toBe(new Date(2026, 9, 17, 9).getTime())
    expect(o.nextWeek).toBe(new Date(2026, 9, 19, 8).getTime())
    expect(o.someday).toBeNull()
  })

  it('rolls tonight to tomorrow after 8pm and weekend forward on Saturday', () => {
    const sat = new Date(2026, 9, 17, 21, 0).getTime()
    const o = Object.fromEntries(snoozeOptions(sat).map((x) => [x.id, x.until]))
    expect(o.tonight).toBe(new Date(2026, 9, 18, 20).getTime())
    expect(o.weekend).toBe(new Date(2026, 9, 24, 9).getTime())
  })
})

describe('splits', () => {
  it('detects automated senders', () => {
    expect(isAutomated({ email: 'no-reply@vercel.com' })).toBe(true)
    expect(isAutomated({ email: 'notifications@github.com' })).toBe(true)
    expect(isAutomated({ email: 'ana@acme.co' })).toBe(false)
  })

  it('treats a thread Zach started as important', () => {
    const me = { email: 'zach@gmail.com' }
    const msg = { from: me, to: [{ email: 'x@y.com' }], cc: [], listUnsubscribe: null }
    const ctx = splitContext(['zach@gmail.com'], [msg as never])
    expect(classify({ starred: false } as never, [msg as never], ctx)).toBe('important')
  })
})

describe('format', () => {
  it('formats short relative times', () => {
    const now = Date.UTC(2026, 9, 13, 16)
    expect(rowTime(now - 30_000, now)).toBe('now')
    expect(rowTime(now - 9 * 60_000, now)).toBe('9m')
    expect(rowTime(now - 3 * 3_600_000, now)).toBe('3h')
  })

  it('strips html to readable text', () => {
    expect(htmlToText('<p>Hi &amp; bye</p><p>Two<br>lines</p>')).toBe('Hi & bye\n\nTwo\nlines')
  })
})
