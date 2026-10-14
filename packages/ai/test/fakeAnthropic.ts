/**
 * A stand-in for the Messages API, passed to the SDK as its `fetch`. Every test talks to this
 * instead of the network; `requests` records what was sent so prompts can be asserted on.
 */
export interface FakeReply {
  /** Text content (for triage, the JSON the structured output would hold). */
  text?: string
  /** Streamed in these pieces when the request streams; defaults to one piece. */
  chunks?: string[]
  stopReason?: 'end_turn' | 'max_tokens' | 'refusal'
  /** Fail the request with this HTTP status instead. */
  status?: number
}

export interface FakeAnthropic {
  fetch: typeof fetch
  requests: { url: string; headers: Headers; body: Record<string, unknown> }[]
}

export const FAKE_ANTHROPIC_URL = 'https://anthropic.test'

export function fakeAnthropic(
  reply: (body: Record<string, unknown>) => FakeReply | Promise<FakeReply>,
): FakeAnthropic {
  const requests: FakeAnthropic['requests'] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(`${FAKE_ANTHROPIC_URL}/v1/messages`))
      return new Response('not found', { status: 404 })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, headers: new Headers(init?.headers), body })
    const r = await reply(body)
    if (r.status) {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'fake failure' } }),
        { status: r.status, headers: { 'content-type': 'application/json' } },
      )
    }
    const text = r.text ?? (r.chunks ?? []).join('')
    const stopReason = r.stopReason ?? 'end_turn'
    const message = {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    }
    if (!body.stream) {
      return new Response(JSON.stringify(message), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const events: [string, unknown][] = [
      [
        'message_start',
        { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      ...(r.chunks ?? [text]).map((t): [string, unknown] => [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
      ]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 5 },
        },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
    const sse = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetch: fetchImpl as typeof fetch, requests }
}
