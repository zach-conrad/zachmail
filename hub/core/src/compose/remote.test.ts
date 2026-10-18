import { describe, expect, it, vi } from 'vitest'
import { HttpError } from '../sync/http'
import { composerHttp, flushComposerEdits, type ComposerEdit } from './remote'

const snippet = {
  id: 's1',
  name: 'Call',
  shortcut: 'call',
  subject: '',
  html: '<p>Hi</p>',
  cc: [],
  bcc: [],
  updatedAt: 5,
}

describe('flushComposerEdits', () => {
  it('sends in order, drops refused edits and stops on retryable errors', async () => {
    const edits: ComposerEdit[] = [
      { kind: 'snippet', id: 's1', value: snippet },
      { kind: 'nudge', id: 't1', value: { id: 't1', lastMessageAt: 1 } },
      { kind: 'snippet', id: 's2', value: null },
      { kind: 'nudge', id: 't2', value: null },
    ]
    const acked: string[] = []
    const rejected: string[] = []
    const calls: string[] = []
    const remote = {
      putSnippet: async (s: { id: string }) => void calls.push(`put ${s.id}`),
      deleteSnippet: async (id: string) => void calls.push(`delete ${id}`),
      dismissNudges: async (ids: string[]) => {
        calls.push(`dismiss ${ids}`)
        throw new HttpError(409, '/x')
      },
      restoreNudges: async () => {
        throw new HttpError(503, '/x')
      },
    }
    const outbox = {
      pending: () => edits,
      ack: (e: ComposerEdit) => void acked.push(e.id),
      reject: (e: ComposerEdit) => void rejected.push(e.id),
    }
    await expect(flushComposerEdits(outbox, remote)).rejects.toThrow()
    expect(calls).toEqual(['put s1', 'dismiss t1', 'delete s2'])
    expect(acked).toEqual(['s1', 's2'])
    expect(rejected).toEqual(['t1'])
  })
})

describe('composerHttp', () => {
  it('maps edits to the API', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const r = composerHttp({ token: () => 'tok', fetch: fetch as never })
    await r.putSnippet(snippet)
    await r.dismissNudges(['t1'])
    const calls = fetch.mock.calls as unknown as [string, RequestInit][]
    const [url, init] = calls[0]!
    const [url2, init2] = calls[1]!
    expect(url).toBe('/api/snippets/s1')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).not.toHaveProperty('id')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(url2).toBe('/api/nudges/dismiss')
    expect(JSON.parse(String(init2.body))).toEqual({ threadIds: ['t1'] })
  })
})
