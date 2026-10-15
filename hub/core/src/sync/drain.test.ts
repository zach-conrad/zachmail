import { describe, expect, it } from 'vitest'
import { OpDrain, type OpQueue } from './drain'
import { HttpError } from './http'
import type { OpEnvelope, OpsResponse } from './ops'

const env = (id: string): OpEnvelope => ({ id, at: 1, op: { kind: 'archive', threadIds: ['t'] } })

function queue(ids: string[]) {
  const q = { unsent: ids.map(env), sent: [] as string[], settled: [] as [string[], boolean][] }
  const api: OpQueue = {
    unsentOps: (n) => q.unsent.slice(0, n),
    markOpsSent: (s) => {
      q.sent.push(...s)
      q.unsent = q.unsent.filter((e) => !s.includes(e.id))
    },
    settleOps: (s, keep = false) => {
      q.settled.push([[...s], keep])
      q.unsent = q.unsent.filter((e) => !s.includes(e.id))
    },
  }
  return { q, api }
}

describe('OpDrain', () => {
  it('sends in order and fails rejected ops', async () => {
    const { q, api } = queue(['a', 'b'])
    const failed: string[] = []
    const sent: string[][] = []
    const drain = new OpDrain(api, {
      send: async (ops): Promise<OpsResponse> => {
        sent.push(ops.map((o) => o.id))
        return { accepted: ['a'], rejected: [{ id: 'b', error: 'gone' }] }
      },
      onFailed: (rows) => failed.push(...rows.map((r) => r.id)),
    })
    await drain.run()
    expect(sent).toEqual([['a', 'b']])
    expect(q.sent).toEqual(['a'])
    expect(failed).toEqual(['b'])
  })

  it('backs off on network errors and resumes on the timer', async () => {
    const { q, api } = queue(['a'])
    const timers: (() => void)[] = []
    let up = false
    const drain = new OpDrain(api, {
      send: async () => {
        if (!up) throw new TypeError('offline')
        return { accepted: ['a'], rejected: [] }
      },
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => {},
    })
    await drain.run()
    expect(q.sent).toEqual([])
    expect(timers).toHaveLength(1)
    up = true
    timers[0]!()
    await new Promise((r) => setTimeout(r, 0))
    expect(q.sent).toEqual(['a'])
  })

  it('isolates a malformed op instead of wedging the queue', async () => {
    const { q, api } = queue(['a', 'bad', 'c'])
    const drain = new OpDrain(api, {
      send: async (ops) => {
        if (ops.some((o) => o.id === 'bad')) throw new HttpError(400, '/api/ops')
        return { accepted: ops.map((o) => o.id), rejected: [] }
      },
    })
    await drain.run()
    expect(q.sent).toEqual(['a', 'c'])
    expect(q.settled).toEqual([[['bad'], false]])
  })

  it('settles ops in place when there is no server', async () => {
    const { q, api } = queue(['a'])
    await new OpDrain(api, { send: null }).run()
    expect(q.settled).toEqual([[['a'], true]])
  })
})
