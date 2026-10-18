import { describe, expect, it } from 'vitest'
import {
  positionAtEnd,
  positionAtStart,
  positionBetween,
  positionForDrop,
  positionForStep,
} from './order'

const items = (...ps: string[]) => ps.map((position) => ({ position }))

describe('fractional ordering', () => {
  it('mints keys between neighbours', () => {
    const a = positionBetween(null, null)
    const b = positionBetween(a, null)
    const mid = positionBetween(a, b)
    expect(a < mid && mid < b).toBe(true)
  })

  it('appends and prepends', () => {
    const list = items('a0', 'a1', 'a2')
    expect(positionAtEnd(list) > 'a2').toBe(true)
    expect(positionAtStart(list) < 'a0').toBe(true)
    expect(positionAtEnd([])).toBe('a0')
  })

  it('steps an item up and down one place', () => {
    const list = items('a0', 'a1', 'a2')
    const up = positionForStep(list, 2, -1)!
    expect('a0' < up && up < 'a1').toBe(true)
    const down = positionForStep(list, 0, 1)!
    expect('a1' < down && down < 'a2').toBe(true)
    expect(positionForStep(list, 0, -1)).toBeNull()
    expect(positionForStep(list, 2, 1)).toBeNull()
    expect(positionForStep(list, 1, -1)! < 'a0').toBe(true)
  })

  it('drops at an index', () => {
    const list = items('a0', 'a1')
    expect(positionForDrop(list, 0) < 'a0').toBe(true)
    const p = positionForDrop(list, 1)
    expect('a0' < p && p < 'a1').toBe(true)
    expect(positionForDrop(list, 2) > 'a1').toBe(true)
  })

  it('heals duplicate keys from two devices', () => {
    expect(positionBetween('a1', 'a1') > 'a1').toBe(true)
  })

  it('never renumbers: 1000 inserts at the front stay ordered and short', () => {
    let first = positionBetween(null, null)
    const keys = [first]
    for (let i = 0; i < 1000; i++) keys.unshift((first = positionBetween(null, first)))
    expect([...keys].sort()).toEqual(keys)
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(8)
  })
})
