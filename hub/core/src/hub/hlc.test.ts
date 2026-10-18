import { describe, expect, it } from 'vitest'
import { parseEntityOpsRequest } from './entities'
import { formatHlc, isHlc, mergeFields, newClock, parseHlc, receive, tick } from './hlc'

describe('hlc', () => {
  it('orders stamps by wall time, then counter, as plain strings', () => {
    const c = newClock('a')
    const s1 = tick(c, 1000)
    const s2 = tick(c, 1000)
    const s3 = tick(c, 999) // clock went backwards: still later
    const s4 = tick(c, 2000)
    expect([s4, s3, s1, s2].sort()).toEqual([s1, s2, s3, s4])
    expect(parseHlc(s3)).toEqual({ ms: 1000, counter: 2, node: 'a' })
    expect(isHlc(s1)).toBe(true)
    expect(isHlc('nope')).toBe(false)
  })

  it('stamps after anything it has received', () => {
    const c = newClock('a')
    receive(c, formatHlc(5000, 7, 'b'), 1000)
    expect(tick(c, 1000) > formatHlc(5000, 7, 'b')).toBe(true)
    // A stamp from days in the future is ignored rather than adopted.
    receive(c, formatHlc(1000 + 2 * 86_400_000, 0, 'b'), 1000)
    expect(parseHlc(tick(c, 1000)).ms).toBe(5000)
  })

  it('merges per field: the newer stamp wins, ties keep what is there', () => {
    const row = { title: 'a', notes: 'x' }
    const clocks = { title: formatHlc(10, 0, 'a'), notes: formatHlc(30, 0, 'a') }
    const r = mergeFields(row, clocks, { title: 'b', notes: 'y' }, formatHlc(20, 0, 'b'))
    expect(r.row).toEqual({ title: 'b', notes: 'x' })
    expect(r.won).toEqual(['title'])
    expect(mergeFields(r.row, r.clocks, { title: 'c' }, formatHlc(20, 0, 'b')).won).toEqual([])
  })
})

describe('parseEntityOpsRequest', () => {
  const id = '00000000-0000-4000-8000-000000000001'
  const hlc = formatHlc(1, 0, 'a')

  it('accepts puts and deletes', () => {
    expect(
      parseEntityOpsRequest({
        ops: [
          { kind: 'put', entity: 'tasks.task', id, hlc, fields: { title: 'x' } },
          { kind: 'delete', entity: 'tasks.task', id, hlc },
        ],
      }).ops,
    ).toHaveLength(2)
  })

  it.each([
    [{ kind: 'put', entity: 'task', id, hlc, fields: { title: 'x' } }, /entity/],
    [{ kind: 'put', entity: 'tasks.task', id: 'x', hlc, fields: { title: 'x' } }, /UUID/],
    [{ kind: 'put', entity: 'tasks.task', id, hlc: 'x', fields: { title: 'x' } }, /HLC/],
    [{ kind: 'put', entity: 'tasks.task', id, hlc, fields: {} }, /empty/],
    [{ kind: 'put', entity: 'tasks.task', id, hlc, fields: { id: 'x' } }, /invalid name/],
    [{ kind: 'nope', entity: 'tasks.task', id, hlc }, /kind/],
  ])('rejects %j', (op, error) => {
    expect(() => parseEntityOpsRequest({ ops: [op] })).toThrow(error)
  })
})
