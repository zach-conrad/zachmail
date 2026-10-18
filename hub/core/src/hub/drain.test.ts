import { describe, expect, it } from 'vitest'
import { HttpError } from '../sync/http'
import { EntityDrain, type EntityDrainOptions, type PendingEntityOp } from './drain'
import { MAX_ENTITY_OPS_PER_REQUEST, type EntityOp, type EntityOpsResponse } from './entities'
import { formatHlc } from './hlc'

const op = (id: string, i: number): EntityOp => ({
  kind: 'put',
  entity: 'tasks.task',
  id,
  hlc: formatHlc(1000 + i, 0, 'dev'),
  fields: { title: id },
})

function queue(ids: string[]) {
  const q = { pending: ids.map((id, i): PendingEntityOp => ({ seq: i + 1, op: op(id, i) })) }
  const acked: number[] = []
  const opts: Pick<EntityDrainOptions, 'pending' | 'ack'> = {
    pending: (n) => q.pending.slice(0, n),
    ack: (seqs) => {
      acked.push(...seqs)
      q.pending = q.pending.filter((p) => !seqs.includes(p.seq))
    },
  }
  return { q, acked, opts }
}

const acceptAll = async (req: { ops: EntityOp[] }): Promise<EntityOpsResponse> => ({
  accepted: req.ops.map((_, i) => i),
  rejected: [],
})

describe('EntityDrain', () => {
  it('sends in order, acks accepted and rejected ops, and reports the rejected', async () => {
    const { acked, opts } = queue(['a', 'b', 'c'])
    const sent: string[][] = []
    const rejected: [string, string][] = []
    await new EntityDrain({
      ...opts,
      send: async (req) => {
        sent.push(req.ops.map((o) => o.id))
        return { accepted: [0, 2], rejected: [{ index: 1, error: 'unknown field' }] }
      },
      onRejected: (rows) => rejected.push(...rows.map((r): [string, string] => [r.op.id, r.error])),
    }).run()
    expect(sent).toEqual([['a', 'b', 'c']])
    expect(acked).toEqual([1, 2, 3])
    expect(rejected).toEqual([['b', 'unknown field']])
  })

  it('splits a long queue into requests of at most the server limit', async () => {
    const ids = Array.from({ length: MAX_ENTITY_OPS_PER_REQUEST + 3 }, (_, i) => `t${i}`)
    const { acked, opts } = queue(ids)
    const sizes: number[] = []
    await new EntityDrain({
      ...opts,
      send: (req) => {
        sizes.push(req.ops.length)
        return acceptAll(req)
      },
    }).run()
    expect(sizes).toEqual([MAX_ENTITY_OPS_PER_REQUEST, 3])
    expect(acked).toHaveLength(ids.length)
  })

  it('backs off on network and server errors and resumes on the timer', async () => {
    const { acked, opts } = queue(['a'])
    const timers: [() => void, number][] = []
    const failures: unknown[] = [new TypeError('offline'), new HttpError(503, '/api/entities')]
    const drain = new EntityDrain({
      ...opts,
      send: async (req) => {
        const err = failures.shift()
        if (err) throw err
        return acceptAll(req)
      },
      setTimeout: (fn, ms) => timers.push([fn, ms]),
      clearTimeout: () => {},
    })
    await drain.run()
    timers[0]![0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(acked).toEqual([])
    expect(timers.map((t) => t[1])).toEqual([1_000, 2_000])
    timers[1]![0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(acked).toEqual([1])
  })

  it('isolates a malformed op instead of wedging the queue', async () => {
    const { acked, opts } = queue(['a', 'bad', 'c'])
    const rejected: string[] = []
    await new EntityDrain({
      ...opts,
      send: async (req) => {
        if (req.ops.some((o) => o.id === 'bad')) throw new HttpError(400, '/api/entities')
        return acceptAll(req)
      },
      onRejected: (rows) => rejected.push(...rows.map((r) => r.op.id)),
    }).run()
    expect(acked.sort()).toEqual([1, 2, 3])
    expect(rejected).toEqual(['bad'])
  })

  it('waits while not ready', async () => {
    const { acked, opts } = queue(['a'])
    let ready = false
    const drain = new EntityDrain({ ...opts, send: acceptAll, ready: () => ready })
    await drain.run()
    expect(acked).toEqual([])
    ready = true
    await drain.run()
    expect(acked).toEqual([1])
  })
})
