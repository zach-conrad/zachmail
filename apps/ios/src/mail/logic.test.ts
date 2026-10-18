import { describe, expect, it } from 'vitest'
import { htmlToText, rowTime } from './format'
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
