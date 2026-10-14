import { describe, expect, it } from 'vitest'
import { fuzzyScore } from './fuzzy'

describe('fuzzyScore', () => {
  it('matches subsequences and ranks prefixes and word starts first', () => {
    expect(fuzzyScore('gts', 'Go to Sent')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'Go to Sent')).toBe(-1)
    expect(fuzzyScore('next', 'Next thread')).toBeGreaterThan(
      fuzzyScore('next', 'Go to next split'),
    )
    expect(fuzzyScore('sent', 'Go to Sent')).toBeGreaterThan(
      fuzzyScore('sent', 'Unsubscribe sender'),
    )
  })
})
