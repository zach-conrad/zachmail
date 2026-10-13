import { describe, expect, it } from 'vitest'
import type { FetchLike } from './api'
import { GmailProvider } from './provider'
import type { GmailMessage } from './types'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')

const msg = (id: string, threadId: string, extra: Partial<GmailMessage> = {}): GmailMessage => ({
  id,
  threadId,
  labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL'],
  snippet: 'Hey Zach &amp; team',
  internalDate: '1791900000000',
  sizeEstimate: 1234,
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Ana Ruiz <ana@example.com>' },
      { name: 'To', value: 'zach@example.com' },
      { name: 'Subject', value: 'Q4 plan' },
      { name: 'Message-ID', value: `<${id}@mail.example.com>` },
      { name: 'References', value: '<a@x> <b@x>' },
    ],
  },
  ...extra,
})

/** Tiny fake of the Gmail REST surface, recording every request. */
function fakeGmail(routes: Record<string, (url: URL) => { status?: number; body: unknown }>) {
  const calls: string[] = []
  let tokenCalls = 0
  const fetchImpl: FetchLike = async (input) => {
    const url = new URL(input)
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    calls.push(`${path}${url.search}`)
    const key = Object.keys(routes).find((k) => new RegExp(`^${k}$`).test(path))
    if (!key) return new Response('not found', { status: 404 })
    const { status = 200, body } = routes[key]!(url)
    return new Response(JSON.stringify(body), { status })
  }
  const tokens = { getAccessToken: async () => `tok${++tokenCalls}` }
  return { fetchImpl, tokens, calls, tokenCalls: () => tokenCalls }
}

describe('GmailProvider.backfillPage', () => {
  it('lists threads in the window, fetches metadata and folders on the first page', async () => {
    const g = fakeGmail({
      '/threads': () => ({ body: { threads: [{ id: 't1' }, { id: 't2' }], nextPageToken: 'p2' } }),
      '/threads/t1': () => ({ body: { id: 't1', messages: [msg('m1', 't1'), msg('m2', 't1')] } }),
      '/threads/t2': () => ({ body: { id: 't2', messages: [msg('m3', 't2', { labelIds: ['SENT'] })] } }),
      '/labels': () => ({
        body: {
          labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'UNREAD', name: 'UNREAD', type: 'system' },
            { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
            { id: 'Label_1', name: 'Receipts', type: 'user' },
          ],
        },
      }),
    })
    const p = new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    const page = await p.backfillPage(null, { sinceDays: 90 })

    expect(page.cursor).toBe('p2')
    expect(g.calls[0]).toContain('q=newer_than%3A90d+-in%3Achats')
    expect(page.batch.folders).toEqual([
      { providerId: 'INBOX', name: 'Inbox', kind: 'inbox', unreadCount: 0, totalCount: 0 },
      { providerId: 'Label_1', name: 'Receipts', kind: 'custom', unreadCount: 0, totalCount: 0 },
    ])
    const m1 = page.batch.messages[0]!
    expect(m1).toMatchObject({
      providerMessageId: 'm1',
      providerThreadId: 't1',
      from: { name: 'Ana Ruiz', email: 'ana@example.com' },
      to: [{ email: 'zach@example.com' }],
      subject: 'Q4 plan',
      snippet: 'Hey Zach & team',
      folderIds: ['INBOX'],
      unread: true,
      rfc822MessageId: '<m1@mail.example.com>',
      references: ['<a@x>', '<b@x>'],
    })
    expect(page.batch.messages).toHaveLength(3)
  })

  it('does not refetch folders on later pages', async () => {
    const g = fakeGmail({ '/threads': () => ({ body: {} }) })
    const page = await new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl }).backfillPage('p2')
    expect(page.batch.folders).toBeUndefined()
    expect(page.cursor).toBeNull()
  })
})

describe('GmailProvider.incremental', () => {
  it('collects touched and deleted messages across history pages', async () => {
    const g = fakeGmail({
      '/history': (u) =>
        u.searchParams.get('pageToken')
          ? { body: { historyId: '200', history: [{ id: '150', messagesDeleted: [{ message: { id: 'm2' } }] }] } }
          : {
              body: {
                historyId: '180',
                nextPageToken: 'n',
                history: [
                  { id: '101', messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] },
                  { id: '102', labelsRemoved: [{ message: { id: 'm3' }, labelIds: ['INBOX'] }] },
                ],
              },
            },
      '/messages/m1': () => ({ body: msg('m1', 't1') }),
      '/messages/m3': () => ({ status: 404, body: {} }),
      '/labels': () => ({ body: { labels: [] } }),
    })
    const r = await new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl }).incremental({ historyId: '100' })
    expect(r.next).toEqual({ historyId: '200' })
    expect(r.batch.messages.map((m) => m.providerMessageId)).toEqual(['m1'])
    expect(r.batch.deletedMessageIds.sort()).toEqual(['m2', 'm3'])
  })

  it('asks for a resync when the history id has expired', async () => {
    const g = fakeGmail({ '/history': () => ({ status: 404, body: {} }) })
    const r = await new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl }).incremental({ historyId: '1' })
    expect(r.resyncRequired).toBe(true)
  })
})

describe('GmailApi auth and retries', () => {
  it('refreshes the token once on 401', async () => {
    let n = 0
    const g = fakeGmail({
      '/profile': () => (n++ === 0 ? { status: 401, body: {} } : { body: { emailAddress: 'z@x', historyId: '9' } }),
    })
    const p = new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl })
    expect(await p.initialState()).toEqual({ historyId: '9' })
    expect(g.tokenCalls()).toBe(2)
  })
})

describe('GmailProvider.fetchBody', () => {
  it('prefers html, decodes charset and loads large parts by attachment id', async () => {
    const g = fakeGmail({
      '/messages/m1': () => ({
        body: {
          id: 'm1',
          threadId: 't1',
          payload: {
            mimeType: 'multipart/mixed',
            parts: [
              {
                mimeType: 'multipart/alternative',
                parts: [
                  { mimeType: 'text/plain', body: { data: b64('plain') } },
                  {
                    mimeType: 'text/html',
                    headers: [{ name: 'Content-Type', value: 'text/html; charset="UTF-8"' }],
                    body: { attachmentId: 'big' },
                  },
                ],
              },
              {
                mimeType: 'application/pdf',
                filename: 'plan.pdf',
                body: { attachmentId: 'att1', size: 2048 },
                headers: [{ name: 'Content-Disposition', value: 'attachment; filename="plan.pdf"' }],
              },
            ],
          },
        },
      }),
      '/messages/m1/attachments/big': () => ({ body: { data: b64('<p>Olá</p>') } }),
    })
    const body = await new GmailProvider({ tokens: g.tokens, fetch: g.fetchImpl }).fetchBody('m1')
    expect(body.html).toBe('<p>Olá</p>')
    expect(body.text).toBe('plain')
    expect(body.attachments).toEqual([
      { filename: 'plan.pdf', mime: 'application/pdf', size: 2048, providerAttachmentId: 'att1', contentId: null, inline: false },
    ])
  })
})
