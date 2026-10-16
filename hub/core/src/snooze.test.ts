import { describe, expect, it } from 'vitest'
import { parseSnoozeTime, snoozeOptions } from './snooze'

// Wednesday 14 Oct 2026, 10:15 local time.
const WED = new Date(2026, 9, 14, 10, 15, 30)
const local = (y: number, mo: number, d: number, h = 8, mi = 0) =>
  new Date(y, mo, d, h, mi).getTime()

describe('snoozeOptions', () => {
  it('resolves the presets from design §3.6', () => {
    const o = Object.fromEntries(snoozeOptions(WED).map((x) => [x.id, x.at]))
    expect(o).toEqual({
      later: local(2026, 9, 14, 13, 15),
      tonight: local(2026, 9, 14, 20),
      tomorrow: local(2026, 9, 15),
      weekend: local(2026, 9, 17, 9),
      nextWeek: local(2026, 9, 19),
      someday: local(2027, 0, 14),
    })
  })

  it('drops tonight late in the day and rolls the weekend forward once it starts', () => {
    const satNoon = new Date(2026, 9, 17, 19, 30)
    const ids = snoozeOptions(satNoon).map((x) => x.id)
    expect(ids).not.toContain('tonight')
    const weekend = snoozeOptions(satNoon).find((x) => x.id === 'weekend')!
    expect(weekend.at).toBe(local(2026, 9, 24, 9))
    const satEarly = snoozeOptions(new Date(2026, 9, 17, 7)).find((x) => x.id === 'weekend')!
    expect(satEarly.at).toBe(local(2026, 9, 17, 9))
    const sunday = snoozeOptions(new Date(2026, 9, 18, 10)).find((x) => x.id === 'nextWeek')!
    expect(sunday.at).toBe(local(2026, 9, 19))
  })
})

describe('parseSnoozeTime', () => {
  const p = (s: string) => parseSnoozeTime(s, WED)
  it('understands relative times', () => {
    expect(p('in 3 days')).toBe(new Date(2026, 9, 17, 10, 15, 30).getTime())
    expect(p('in 2 hours')).toBe(WED.getTime() + 2 * 3_600_000)
    expect(p('in an hour')).toBe(WED.getTime() + 3_600_000)
    expect(p('in 1 week')).toBe(new Date(2026, 9, 21, 10, 15, 30).getTime())
  })

  it('understands days, times and dates', () => {
    expect(p('tomorrow')).toBe(local(2026, 9, 15))
    expect(p('Tomorrow 8:30pm')).toBe(local(2026, 9, 15, 20, 30))
    expect(p('fri')).toBe(local(2026, 9, 16))
    expect(p('next monday at 9am')).toBe(local(2026, 9, 19, 9))
    expect(p('wed')).toBe(local(2026, 9, 21))
    expect(p('3pm')).toBe(local(2026, 9, 14, 15))
    expect(p('9am')).toBe(local(2026, 9, 15, 9))
    expect(p('noon')).toBe(local(2026, 9, 14, 12))
    expect(p('tonight')).toBe(local(2026, 9, 14, 20))
    expect(p('oct 20 2pm')).toBe(local(2026, 9, 20, 14))
    expect(p('20th October')).toBe(local(2026, 9, 20))
    expect(p('10/20')).toBe(local(2026, 9, 20))
    expect(p('jan 5')).toBe(local(2027, 0, 5))
    expect(p('next week')).toBe(local(2026, 9, 19))
    expect(p('weekend')).toBe(local(2026, 9, 17, 9))
    expect(p('Someday')).toBe(local(2027, 0, 14))
  })

  it('refuses what it does not understand or what is in the past', () => {
    for (const s of ['', 'soon', 'oct 32', '2/30', '25:00', 'in 3 fortnights', 'today 9am', '14'])
      expect(p(s)).toBeNull()
  })
})
