import { describe, expect, it, vi } from 'vitest'
import {
  SyncClient,
  ResyncRequired,
  startSyncLoop,
  type SyncSink,
  type SyncTransport,
} from './client'
import { readNdjson } from './http'
import { emptyDeletes, emptyRows, type BootstrapLine, type Rows, type SyncDelta } from './protocol'
import { classifySplit } from './split'

function memorySink() {
  const state = { seq: null as number | null, applied: [] as Partial<Rows>[], resets: 0 }
  const sink: SyncSink = {
    getSeq: () => state.seq,
    reset: () => {
      state.resets++
      state.seq = null
      state.applied = []
    },
    apply: (rows, _d, seq) => {
      state.applied.push(rows)
      if (seq !== null) state.seq = seq
    },
  }
  return { state, sink }
}

const delta = (seq: number, more = false, threads = 0): SyncDelta => ({
  seq,
  more,
  upserts: { ...emptyRows(), threads: Array.from({ length: threads }, () => ({}) as never) },
  deletes: emptyDeletes(),
  ops: [],
})

function transport(lines: BootstrapLine[], deltas: Record<number, SyncDelta | Error>) {
  const calls: number[] = []
  const t: SyncTransport = {
    async *bootstrap() {
      for (const l of lines) yield l
    },
    async delta(since) {
      calls.push(since)
      const d = deltas[since]
      if (d instanceof Error) throw d
      return d ?? delta(since)
    },
  }
  return { t, calls }
}

describe('SyncClient', () => {
  it('bootstraps when there is no cursor, then pulls deltas until caught up', async () => {
    const { state, sink } = memorySink()
    const { t, calls } = transport([{ rows: { threads: [] } }, { seq: 10 }], {
      10: delta(12, true, 1),
      12: delta(13, false, 1),
    })
    const onChange = vi.fn()
    await new SyncClient(sink, t, { onChange }).pull()
    expect(state.resets).toBe(1)
    expect(state.seq).toBe(13)
    expect(calls).toEqual([10, 12])
    expect(onChange).toHaveBeenCalledTimes(4)
  })

  it('coalesces concurrent pulls into one follow-up', async () => {
    const { state, sink } = memorySink()
    state.seq = 1
    const { t, calls } = transport([], {})
    const c = new SyncClient(sink, t)
    await Promise.all([c.pull(), c.pull(), c.pull()])
    expect(calls).toEqual([1, 1])
  })

  it('bootstraps again when the cursor has expired', async () => {
    const { state, sink } = memorySink()
    state.seq = 1
    const { t } = transport([{ seq: 50 }], { 1: new ResyncRequired() })
    await new SyncClient(sink, t).pull()
    expect(state.resets).toBe(1)
    expect(state.seq).toBe(50)
  })

  it('reports errors without throwing', async () => {
    const { state, sink } = memorySink()
    state.seq = 1
    const onError = vi.fn()
    await new SyncClient(sink, transport([], { 1: new Error('down') }).t, { onError }).pull()
    expect(onError).toHaveBeenCalledOnce()
  })

  it('loop pulls on start, on interval and on triggers', () => {
    const pull = vi.fn(() => Promise.resolve())
    let tick: () => void = () => {}
    let fire: () => void = () => {}
    const stop = startSyncLoop(
      { pull },
      {
        setInterval: (fn) => ((tick = fn), 1),
        clearInterval: () => {},
        triggers: [(p) => ((fire = p), () => {})],
      },
    )
    tick()
    fire()
    expect(pull).toHaveBeenCalledTimes(3)
    stop()
  })
})

describe('readNdjson', () => {
  it('parses lines split across chunks', async () => {
    const enc = new TextEncoder()
    const parts = ['{"rows":{}}\n{"se', 'q":4}\n']
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p))
        c.close()
      },
    })
    const out: unknown[] = []
    for await (const v of readNdjson(stream)) out.push(v)
    expect(out).toEqual([{ rows: {} }, { seq: 4 }])
  })
})

describe('classifySplit', () => {
  const base = {
    folderKinds: ['inbox'] as const,
    accountHasImportant: true,
    hasListUnsubscribe: false,
  }
  it('routes by inbox, list, automated sender and importance', () => {
    expect(classifySplit({ ...base, folderKinds: [], fromEmail: 'a@b.c' })).toBeNull()
    expect(classifySplit({ ...base, hasListUnsubscribe: true, fromEmail: 'a@b.c' })).toBe(
      'newsletters',
    )
    expect(classifySplit({ ...base, fromEmail: 'no-reply@x.com' })).toBe('notifications')
    expect(classifySplit({ ...base, fromEmail: 'noreply+abc@x.com' })).toBe('notifications')
    expect(classifySplit({ ...base, fromEmail: 'nora@x.com' })).toBe('other')
    expect(
      classifySplit({ ...base, folderKinds: ['inbox', 'important'], fromEmail: 'a@b.c' }),
    ).toBe('important')
    expect(classifySplit({ ...base, accountHasImportant: false, fromEmail: 'a@b.c' })).toBe(
      'important',
    )
  })
})
