import { describe, expect, it } from 'vitest'
import type { ClaimedJob, Queue } from './queue'
import { Runner, backoffMs } from './runner'

function fakeQueue(jobs: ClaimedJob[]) {
  const ready = [...jobs]
  const done: number[] = []
  const failed: { id: number; retry: number | null }[] = []
  const queue: Queue = {
    claim: async (_w, n) => ready.splice(0, n),
    complete: async (id) => void done.push(id),
    fail: async (job, _e, retry) => void failed.push({ id: job.id, retry }),
    reapStale: async () => 0,
  }
  return { queue, done, failed, ready }
}

const job = (id: number, kind: string, attempts = 1, maxAttempts = 3): ClaimedJob => ({
  id,
  kind,
  attempts,
  maxAttempts,
  userId: 'u',
  payload: {},
})

describe('Runner', () => {
  it('runs every ready job and completes it', async () => {
    const seen: number[] = []
    const q = fakeQueue([job(1, 'a'), job(2, 'a'), job(3, 'a')])
    const r = new Runner({
      workerId: 'w',
      queue: q.queue,
      concurrency: 2,
      handlers: { a: async (j) => void seen.push(j.id) },
    })
    await r.tick()
    expect(seen.sort()).toEqual([1, 2, 3])
    expect(q.done.sort()).toEqual([1, 2, 3])
  })

  it('retries failures with backoff and dead-letters after max attempts', async () => {
    const q = fakeQueue([job(1, 'boom', 1, 3), job(2, 'boom', 3, 3), job(3, 'unknown')])
    const r = new Runner({
      workerId: 'w',
      queue: q.queue,
      handlers: {
        boom: async () => {
          throw new Error('nope')
        },
      },
    })
    await r.tick()
    const byId = Object.fromEntries(q.failed.map((f) => [f.id, f.retry]))
    expect(byId[1]).toBeGreaterThan(0)
    expect(byId[2]).toBeNull()
    expect(byId[3]).toBeGreaterThan(0)
    expect(q.done).toEqual([])
  })

  it('coalesces overlapping ticks into one follow-up drain', async () => {
    const q = fakeQueue([job(1, 'a')])
    const r = new Runner({ workerId: 'w', queue: q.queue, handlers: { a: async () => {} } })
    const first = r.tick()
    q.ready.push(job(2, 'a'))
    void r.tick()
    await first
    await new Promise((res) => setTimeout(res, 0))
    await r.tick()
    expect(q.done.sort()).toEqual([1, 2])
  })
})

describe('backoffMs', () => {
  it('grows exponentially and caps at ten minutes', () => {
    const mid = () => 0.5
    expect(backoffMs(1, mid)).toBe(2000)
    expect(backoffMs(3, mid)).toBe(8000)
    expect(backoffMs(30, mid)).toBe(600000)
  })
})
