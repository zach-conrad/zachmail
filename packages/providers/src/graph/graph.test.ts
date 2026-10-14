import { describe, expect, it } from 'vitest'
import { ProviderAuthError } from '../types'
import type { FetchLike } from '../types'
import { GraphProvider } from './provider'
import type { GraphMessage, WellKnownFolders } from './types'

const WK: WellKnownFolders = {
  inbox: 'F-inbox',
  sentitems: 'F-sent',
  drafts: 'F-drafts',
  deleteditems: 'F-trash',
  junkemail: 'F-junk',
  archive: 'F-archive',
  conversationhistory: 'F-convo',
}

const msg = (id: string, extra: Partial<GraphMessage> = {}): GraphMessage => ({
  id,
  conversationId: `c-${id}`,
  internetMessageId: `<${id}@mail.example.com>`,
  subject: 'Q4 plan',
  bodyPreview: 'Hey Zach,\r\n  numbers attached',
  from: { emailAddress: { name: 'Ana Ruiz', address: 'ana@example.com' } },
  toRecipients: [{ emailAddress: { name: 'zach@zachconrad.dev', address: 'zach@zachconrad.dev' } }],
  receivedDateTime: '2026-10-13T10:00:00Z',
  parentFolderId: 'F-inbox',
  isRead: false,
  isDraft: false,
  flag: { flagStatus: 'notFlagged' },
  hasAttachments: false,
  ...extra,
})

type Reply = { status?: number; body?: unknown; bytes?: Uint8Array }
type Route = (req: { url: URL; method: string; body: unknown; raw?: string }) => Reply

/** Fake Graph: routes by "METHOD /path" regex, and unpacks $batch into the same routes. */
function fakeGraph(routes: Record<string, Route>) {
  const calls: string[] = []
  const route = (method: string, url: URL, body: unknown, raw?: string): Reply => {
    const path = url.pathname.replace('/v1.0', '')
    calls.push(`${method} ${path}${url.search}`)
    const key = Object.keys(routes).find((k) => new RegExp(`^${k}$`).test(`${method} ${path}`))
    if (!key) return { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
    return routes[key]!({ url, method, body, raw })
  }
  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const text = typeof init?.body === 'string' ? init.body : undefined
    if (url.pathname === '/v1.0/$batch') {
      const { requests } = JSON.parse(text!) as {
        requests: { id: string; method: string; url: string; body?: unknown }[]
      }
      const responses = requests.map((r) => {
        const res = route(r.method, new URL('https://graph.microsoft.com/v1.0' + r.url), r.body)
        return { id: r.id, status: res.status ?? 200, body: res.body ?? {} }
      })
      return new Response(JSON.stringify({ responses: responses.reverse() }))
    }
    const isJson =
      init?.headers &&
      (init.headers as Record<string, string>)['content-type'] === 'application/json'
    const res = route(
      method,
      url,
      isJson && text ? JSON.parse(text) : undefined,
      isJson ? undefined : text,
    )
    if (res.bytes) return new Response(res.bytes)
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
    })
  }
  let tokenCalls = 0
  const tokens = { getAccessToken: async () => `tok${++tokenCalls}` }
  return { fetchImpl, tokens, calls, tokenCalls: () => tokenCalls }
}

const folderRoutes: Record<string, Route> = {
  'GET /me/mailFolders/(\\w+)': ({ url }) => {
    const name = url.pathname.split('/').pop() as keyof WellKnownFolders
    return WK[name] ? { body: { id: WK[name] } } : { status: 404, body: {} }
  },
  'GET /me/mailFolders': () => ({
    body: {
      value: [
        { id: 'F-inbox', displayName: 'Inbox', unreadItemCount: 3, totalItemCount: 9 },
        { id: 'F-sent', displayName: 'Sent Items' },
        { id: 'F-archive', displayName: 'Archive' },
        { id: 'F-proj', displayName: 'Projects', childFolderCount: 1 },
        { id: 'F-convo', displayName: 'Conversation History', childFolderCount: 1 },
      ],
    },
  }),
  'GET /me/mailFolders/F-proj/childFolders': () => ({
    body: { value: [{ id: 'F-acme', displayName: 'Acme', parentFolderId: 'F-proj' }] },
  }),
}

describe('GraphProvider.backfillPage', () => {
  it('lists recent mail newest first with folders and attachment lists', async () => {
    const g = fakeGraph({
      ...folderRoutes,
      'GET /me/messages': () => ({
        body: {
          value: [msg('m1', { hasAttachments: true }), msg('m2', { isRead: true })],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=100',
        },
      }),
      'GET /me/messages/m1/attachments': () => ({
        body: {
          value: [
            { id: 'a1', name: 'q4.xlsx', contentType: 'application/x', size: 10, isInline: false },
          ],
        },
      }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    const page = await p.backfillPage(null, { sinceDays: 90 })

    expect(page.cursor).toBe('https://graph.microsoft.com/v1.0/me/messages?$skip=100')
    const list = g.calls.find((c) => c.startsWith('GET /me/messages?'))!
    expect(decodeURIComponent(list)).toContain('$orderby=receivedDateTime desc')
    expect(decodeURIComponent(list)).toMatch(/\$filter=receivedDateTime ge 2026-/)
    expect(page.batch.folders?.map((f) => [f.providerId, f.kind])).toEqual([
      ['F-inbox', 'inbox'],
      ['F-sent', 'sent'],
      ['F-archive', 'archive'],
      ['F-proj', 'custom'],
      ['F-acme', 'custom'],
    ])
    expect(page.batch.folders?.[0]).toMatchObject({ name: 'Inbox', unreadCount: 3, totalCount: 9 })
    expect(page.batch.messages[0]).toMatchObject({
      providerMessageId: 'm1',
      providerThreadId: 'c-m1',
      rfc822MessageId: '<m1@mail.example.com>',
      from: { name: 'Ana Ruiz', email: 'ana@example.com' },
      to: [{ email: 'zach@zachconrad.dev' }],
      snippet: 'Hey Zach, numbers attached',
      folderIds: ['F-inbox'],
      unread: true,
      starred: false,
      hasAttachments: true,
      attachments: [
        {
          filename: 'q4.xlsx',
          mime: 'application/x',
          size: 10,
          providerAttachmentId: 'a1',
          contentId: null,
          inline: false,
        },
      ],
    })
    expect(page.batch.messages[1]!.unread).toBe(false)
    expect(g.calls.filter((c) => c.includes('/attachments'))).toHaveLength(1)
  })

  it('leaves older mail to the folder deltas', async () => {
    const g = fakeGraph({})
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl, wellKnown: WK })
    expect(await p.backfillPage(null, { beforeDays: 90 })).toEqual({
      batch: { messages: [], deletedMessageIds: [] },
      cursor: null,
    })
    expect(g.calls).toEqual([])
  })
})

describe('GraphProvider.incremental', () => {
  it('runs every folder delta, follows pages, and tells moves from deletions', async () => {
    const delta = (folder: string) => `https://graph.microsoft.com/v1.0/delta-done/${folder}`
    const g = fakeGraph({
      ...folderRoutes,
      'GET /me/mailFolders/F-inbox/messages/delta': () => ({
        body: {
          value: [msg('m1'), { id: 'moved', '@removed': { reason: 'deleted' } }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/inbox-page-2',
        },
      }),
      'GET /inbox-page-2': () => ({
        body: { value: [{ id: 'gone', '@removed': {} }], '@odata.deltaLink': delta('F-inbox') },
      }),
      // A known folder resumes from its stored link.
      'GET /stored/F-archive': () => ({
        body: { value: [], '@odata.deltaLink': delta('F-archive') },
      }),
      'GET /me/mailFolders/F-(sent|proj|acme)/messages/delta': ({ url }) => ({
        body: { value: [], '@odata.deltaLink': delta(url.pathname.split('/')[4]!) },
      }),
      'GET /me/messages/moved': () => ({ body: msg('moved', { parentFolderId: 'F-archive' }) }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    const r = await p.incremental({
      deltas: { 'F-archive': 'https://graph.microsoft.com/v1.0/stored/F-archive' },
    })

    expect(r.more).toBe(false)
    expect(r.batch.messages.map((m) => [m.providerMessageId, m.folderIds[0]])).toEqual([
      ['m1', 'F-inbox'],
      ['moved', 'F-archive'],
    ])
    expect(r.batch.deletedMessageIds).toEqual(['gone'])
    expect(r.batch.folders).toHaveLength(5)
    expect(r.next).toMatchObject({
      deltas: {
        'F-inbox': delta('F-inbox'),
        'F-archive': delta('F-archive'),
        'F-sent': delta('F-sent'),
        'F-proj': delta('F-proj'),
        'F-acme': delta('F-acme'),
      },
      wellKnown: WK,
    })
    // Hidden folders are never synced.
    expect(g.calls.some((c) => c.includes('F-convo/messages'))).toBe(false)
  })

  it('caps a first pass and resumes it next run; restarts an expired folder', async () => {
    const g = fakeGraph({
      ...folderRoutes,
      'GET /me/mailFolders/F-inbox/messages/delta': () => ({
        body: { value: [msg('a')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/p2' },
      }),
      'GET /p2': () => ({
        body: { value: [msg('b')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/p3' },
      }),
      'GET /expired': () => ({ status: 410, body: { error: { code: 'SyncStateNotFound' } } }),
      'GET /me/mailFolders/F-.*/messages/delta': () => ({
        body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/done' },
      }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl, maxDeltaPages: 2 })
    const r = await p.incremental({
      deltas: { 'F-sent': 'https://graph.microsoft.com/v1.0/expired' },
    })
    expect(r.more).toBe(true)
    expect(r.batch.messages.map((m) => m.providerMessageId)).toEqual(['a', 'b'])
    const deltas = (r.next as { deltas: Record<string, string> }).deltas
    expect(deltas['F-inbox']).toBe('https://graph.microsoft.com/v1.0/p3')
    expect(deltas['F-sent']).toBe('https://graph.microsoft.com/v1.0/done')
  })

  it('asks for a resync without a delta state', async () => {
    const g = fakeGraph({})
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    expect((await p.incremental({})).resyncRequired).toBe(true)
  })
})

describe('GraphProvider.apply', () => {
  const convo = [
    msg('in1', { receivedDateTime: '2026-10-13T09:00:00Z', isRead: true }),
    msg('in2', { receivedDateTime: '2026-10-13T11:00:00Z' }),
    msg('sent1', {
      parentFolderId: 'F-sent',
      receivedDateTime: '2026-10-13T12:00:00Z',
      isRead: true,
    }),
    msg('draft1', { parentFolderId: 'F-drafts', isDraft: true }),
  ]
  function setup() {
    const writes: string[] = []
    const g = fakeGraph({
      'GET /me/messages': ({ url }) => {
        expect(url.searchParams.get('$filter')).toBe("conversationId eq 'c1'")
        return { body: { value: convo } }
      },
      'POST /me/messages/(\\w+)/move': ({ url, body }) => {
        writes.push(
          `move ${url.pathname.split('/')[4]} → ${(body as { destinationId: string }).destinationId}`,
        )
        return { status: 201, body: {} }
      },
      'PATCH /me/messages/(\\w+)': ({ url, body }) => {
        writes.push(`patch ${url.pathname.split('/')[4]} ${JSON.stringify(body)}`)
        return { body: {} }
      },
    })
    return { p: new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl, wellKnown: WK }), writes }
  }

  it('archives received mail and marks the conversation read', async () => {
    const { p, writes } = setup()
    await p.apply(['c1'], { add: [], remove: ['F-inbox'], unread: false })
    expect(writes).toEqual([
      'patch in2 {"isRead":true}',
      'move in1 → F-archive',
      'move in2 → F-archive',
    ])
  })

  it('trashes the sent copies too, but never drafts', async () => {
    const { p, writes } = setup()
    await p.apply(['c1'], { add: ['F-trash'], remove: ['F-inbox'] })
    expect(writes).toEqual(['move in1 → F-trash', 'move in2 → F-trash', 'move sent1 → F-trash'])
  })

  it('flags and marks unread only the latest received message', async () => {
    const { p, writes } = setup()
    await p.apply(['c1'], { add: [], remove: [], unread: true, starred: true })
    // in2 is already unread, so only the flag is written.
    expect(writes).toEqual(['patch in2 {"flag":{"flagStatus":"flagged"}}'])
  })
})

describe('GraphProvider send and drafts', () => {
  it('sends by creating a draft from MIME and sending it', async () => {
    const seen: string[] = []
    const g = fakeGraph({
      'POST /me/messages': ({ raw }) => {
        seen.push(Buffer.from(raw!, 'base64').toString())
        return { status: 201, body: { id: 'd1', conversationId: 'c9' } }
      },
      'POST /me/messages/d1/send': () => ({ status: 202 }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    const ref = await p.send(new TextEncoder().encode('Subject: hi\r\n\r\nbody'))
    expect(ref).toEqual({ providerMessageId: 'd1', providerThreadId: 'c9' })
    expect(seen).toEqual(['Subject: hi\r\n\r\nbody'])
    await expect(p.send(new Uint8Array(3_200_000))).rejects.toMatchObject({ retriable: false })
  })

  it('drops the draft when Graph refuses the send', async () => {
    const g = fakeGraph({
      'POST /me/messages': () => ({ status: 201, body: { id: 'd1' } }),
      'POST /me/messages/d1/send': () => ({ status: 400, body: { error: { code: 'Bad' } } }),
      'POST /me/messages/d1/permanentDelete': () => ({ status: 204 }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    await expect(p.send(new Uint8Array([65]))).rejects.toMatchObject({ status: 400 })
    expect(g.calls).toContain('POST /me/messages/d1/permanentDelete')
  })

  it('replaces drafts by creating anew and deleting the old one', async () => {
    const g = fakeGraph({
      'POST /me/messages': () => ({ status: 201, body: { id: 'd2' } }),
      'POST /me/messages/d1/permanentDelete': () => ({ status: 404, body: {} }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    expect(await p.saveDraft(new Uint8Array([65]), { providerDraftId: 'd1' })).toBe('d2')
    await p.deleteDraft('d1') // already gone is fine
  })
})

describe('GraphProvider.fetchBody', () => {
  it('embeds inline cid images as data URLs', async () => {
    const g = fakeGraph({
      'GET /me/messages/m1': () => ({
        body: {
          body: {
            contentType: 'html',
            content: '<p>Hi</p><img src="cid:logo@x"><img src="cid:big@x">',
          },
        },
      }),
      'GET /me/messages/m1/attachments': () => ({
        body: {
          value: [
            { id: 'a1', name: 'logo.png', contentType: 'image/png', size: 3, isInline: true },
            {
              id: 'a2',
              name: 'big.png',
              contentType: 'image/png',
              size: 5_000_000,
              isInline: true,
            },
          ],
        },
      }),
      'GET /me/messages/m1/attachments/a1': () => ({
        body: { id: 'a1', contentType: 'image/png', contentId: '<logo@x>', contentBytes: 'AAAA' },
      }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    const body = await p.fetchBody('m1')
    expect(body.html).toBe('<p>Hi</p><img src="data:image/png;base64,AAAA"><img src="cid:big@x">')
    expect(body.attachments.map((a) => a.providerAttachmentId)).toEqual(['a1', 'a2'])
  })

  it('returns plain text bodies as text', async () => {
    const g = fakeGraph({
      'GET /me/messages/m1': () => ({ body: { body: { contentType: 'text', content: 'hi' } } }),
      'GET /me/messages/m1/attachments': () => ({ body: { value: [] } }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    expect(await p.fetchBody('m1')).toEqual({ html: null, text: 'hi', attachments: [] })
  })
})

describe('GraphProvider.watch', () => {
  it('renews a live subscription and recreates a vanished one', async () => {
    let live = true
    const g = fakeGraph({
      'PATCH /subscriptions/s1': () => (live ? { body: {} } : { status: 404, body: {} }),
      'POST /subscriptions': ({ body }) => {
        expect(body).toMatchObject({
          changeType: 'created,updated,deleted',
          resource: 'me/messages',
          notificationUrl: 'https://mail.example.com/webhooks/graph',
          lifecycleNotificationUrl: 'https://mail.example.com/webhooks/graph',
          clientState: 'secret',
        })
        return { status: 201, body: { id: 's2', expirationDateTime: '2026-10-17T00:00:00Z' } }
      },
    })
    const p = new GraphProvider({
      tokens: g.tokens,
      fetch: g.fetchImpl,
      notifications: { url: 'https://mail.example.com/webhooks/graph', clientState: 'secret' },
    })
    expect((await p.watch({ subscriptionId: 's1' })).state.subscriptionId).toBe('s1')
    live = false
    const w = await p.watch({ subscriptionId: 's1' })
    expect(w.state.subscriptionId).toBe('s2')
    expect(w.expiresAt.toISOString()).toBe('2026-10-17T00:00:00.000Z')
  })
})

describe('GraphApi auth', () => {
  it('refreshes the token once on 401, then reports an auth error', async () => {
    let n = 0
    const g = fakeGraph({
      'GET /me': () => ({ status: ++n < 2 ? 401 : 200, body: { mail: 'z@x.dev' } }),
    })
    const p = new GraphProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    expect((await p.profile()).email).toBe('z@x.dev')
    expect(g.tokenCalls()).toBe(2)

    const always = fakeGraph({ 'GET /me': () => ({ status: 401, body: {} }) })
    const q = new GraphProvider({ tokens: always.tokens, fetch: always.fetchImpl })
    await expect(q.profile()).rejects.toBeInstanceOf(ProviderAuthError)
  })
})
