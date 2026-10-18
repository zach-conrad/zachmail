import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from './fuzzy'

describe('fuzzy', () => {
  it('needs every character in order', () => {
    expect(fuzzyScore('gtd', 'Go to Done')).toBeGreaterThan(0)
    expect(fuzzyScore('dg', 'Go to Done')).toBe(-1)
  })

  it('ranks word starts and runs first', () => {
    const items = ['Mark done', 'Go to Done', 'Snooze']
    expect(fuzzyFilter(items, 'done', (x) => x)).toEqual(['Mark done', 'Go to Done'])
    expect(fuzzyFilter(items, 'gd', (x) => x)[0]).toBe('Go to Done')
  })

  it('keeps everything, in order, for an empty query', () => {
    expect(fuzzyFilter(['b', 'a'], ' ', (x) => x)).toEqual(['b', 'a'])
  })
})
