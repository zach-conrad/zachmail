import { describe, expect, it } from 'vitest'
import { dueTime, senderLabel, shortTime } from './format'

describe('shortTime', () => {
  const now = new Date(2026, 9, 13, 12, 0).getTime()
  it('uses minutes, hours, weekday, then date', () => {
    expect(shortTime(now - 30_000, now)).toBe('now')
    expect(shortTime(now - 9 * 60_000, now)).toBe('9m')
    expect(shortTime(now - 2 * 3_600_000, now)).toBe('2h')
    expect(shortTime(now - 3 * 86_400_000, now)).toMatch(/\w{3}/)
    expect(shortTime(new Date(2024, 0, 2).getTime(), now)).toMatch(/2024/)
  })
})

describe('dueTime', () => {
  const now = new Date(2026, 9, 14, 10, 0).getTime()
  it('names today, tomorrow and this week, then dates', () => {
    expect(dueTime(new Date(2026, 9, 14, 15, 0).getTime(), now)).toMatch(/^Today 3:00/)
    expect(dueTime(new Date(2026, 9, 15, 8, 0).getTime(), now)).toMatch(/^Tomorrow 8:00/)
    expect(dueTime(new Date(2026, 9, 17, 9, 0).getTime(), now)).toMatch(/^\w{3} 9:00/)
    expect(dueTime(new Date(2027, 0, 14, 8, 0).getTime(), now)).toMatch(/2027, 8:00/)
  })
})

describe('senderLabel', () => {
  const own = new Set(['zach@example.com'])
  it('drops my own address and shortens groups to first names', () => {
    expect(senderLabel([{ name: 'Ana Ruiz', email: 'ana@x.com' }], own)).toBe('Ana Ruiz')
    expect(senderLabel([{ email: 'zach@example.com' }], own)).toBe('me')
    expect(
      senderLabel(
        [
          { name: 'Ana Ruiz', email: 'ana@x.com' },
          { name: 'Zach', email: 'zach@example.com' },
          { email: 'sam@y.com' },
        ],
        own,
      ),
    ).toBe('Ana, sam')
  })
})
