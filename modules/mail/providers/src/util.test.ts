import { describe, expect, it } from 'vitest'
import { mapLimit } from './util'

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('mapLimit', () => {
  it('keeps input order with limited concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      peak = Math.max(peak, ++inFlight)
      await tick()
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })

  it('starts nothing new after a failure and rejects only once in-flight calls settle', async () => {
    const started: number[] = []
    const finished: number[] = []
    await expect(
      mapLimit([1, 2, 3, 4], 2, async (n) => {
        started.push(n)
        if (n === 1) throw new Error('boom')
        await tick()
        finished.push(n)
      }),
    ).rejects.toThrow('boom')
    expect(started).toEqual([1, 2])
    expect(finished).toEqual([2])
  })
})
