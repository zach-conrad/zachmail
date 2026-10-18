import { describe, expect, it } from 'vitest'
import { parseAssistRequest, readAssistStream } from './ai'

describe('parseAssistRequest', () => {
  const T = '00000000-0000-4000-8000-000000000001'
  it('accepts each mode with what it needs', () => {
    expect(parseAssistRequest({ mode: 'summarize', threadId: T })).toEqual({
      mode: 'summarize',
      threadId: T,
    })
    expect(parseAssistRequest({ mode: 'rewrite', text: ' hi ', instruction: '' })).toEqual({
      mode: 'rewrite',
      text: 'hi',
    })
    expect(parseAssistRequest({ mode: 'draft', instruction: 'ask for the deck' })).toEqual({
      mode: 'draft',
      instruction: 'ask for the deck',
    })
  })
  it('rejects incomplete or malformed requests', () => {
    for (const bad of [
      null,
      { mode: 'x' },
      { mode: 'summarize' },
      { mode: 'rewrite' },
      { mode: 'draft' },
      { mode: 'draft', threadId: 'nope' },
      { mode: 'rewrite', text: 'x'.repeat(50_001) },
    ])
      expect(() => parseAssistRequest(bad)).toThrow()
  })
})

describe('readAssistStream', () => {
  const body = (lines: string[]) => new Response(lines.map((l) => l + '\n').join('')).body!

  it('yields text until done', async () => {
    const out: string[] = []
    for await (const t of readAssistStream(
      body([
        '{"type":"text","text":"a"}',
        '{"type":"text","text":"b"}',
        '{"type":"done","truncated":false}',
      ]),
    ))
      out.push(t)
    expect(out).toEqual(['a', 'b'])
  })

  it('throws on error events and early ends', async () => {
    const drain = async (b: ReadableStream<Uint8Array>) => {
      for await (const _ of readAssistStream(b)) void _
    }
    await expect(drain(body(['{"type":"error","message":"nope"}']))).rejects.toThrow('nope')
    await expect(drain(body(['{"type":"text","text":"a"}']))).rejects.toThrow('ended early')
  })
})
