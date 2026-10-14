import { describe, expect, it } from 'vitest'
import { senderLabel, shortTime } from './format'

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
