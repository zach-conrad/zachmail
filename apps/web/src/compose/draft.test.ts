import type { MessageRow } from '@zachhub/core'
import type { ThreadDetail } from '@zachhub/local-store'
import { describe, expect, it } from 'vitest'
import { parseAddresses, replyDraft, textToHtml, toSendRequest } from './draft'

const me = { name: 'Zach', email: 'zach@x.dev' }
const ana = { name: 'Ana', email: 'ana@a.com' }
const bo = { name: 'Bo', email: 'bo@b.com' }
const cy = { email: 'cy@c.com' }

const msg = (id: string, extra: Partial<MessageRow>): MessageRow => ({
  id,
  threadId: 't',
  accountId: 'acc',
  from: ana,
  to: [me],
  cc: [],
  replyTo: [],
  subject: 'Plan',
  snippet: '',
  date: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  rfc822MessageId: null,
  bodyStatus: 'cached',
  ...extra,
})

const detail = (messages: MessageRow[]): ThreadDetail => ({
  thread: {
    id: 't',
    accountId: 'acc',
    subject: 'Plan',
    snippet: '',
    participants: [],
    lastMessageAt: 1,
    messageCount: messages.length,
    unread: false,
    starred: false,
    hasAttachments: false,
    folderIds: [],
  },
  messages,
  bodies: {},
})

const own = new Set([me.email])

describe('replyDraft', () => {
  it('replies to the sender and reply-all copies everyone else', () => {
    const d = detail([msg('m1', { to: [me, bo], cc: [cy] })])
    const r = replyDraft(d, 'reply', own)
    expect(r.to).toEqual([ana])
    expect(r.cc).toEqual([])
    expect(r.subject).toBe('Re: Plan')
    expect(r.replyToMessageId).toBe('m1')
    const all = replyDraft(d, 'replyAll', own)
    expect(all.to).toEqual([ana])
    expect(all.cc).toEqual([bo, cy])
  })

  it('honours Reply-To and answers the latest message from someone else', () => {
    const d = detail([
      msg('m1', { replyTo: [cy], subject: 'Re: Plan' }),
      msg('m2', { from: me, to: [ana] }),
    ])
    const r = replyDraft(d, 'reply', own)
    expect(r.to).toEqual([cy])
    expect(r.subject).toBe('Re: Plan')
    expect(r.replyToMessageId).toBe('m1')
  })

  it('forwards with a header and the original body', () => {
    const f = replyDraft(detail([msg('m1', {})]), 'forward', own, '<p>hi</p>')
    expect(f.to).toEqual([])
    expect(f.subject).toBe('Fwd: Plan')
    expect(f.quoted).toContain('Forwarded message')
    expect(f.quoted).toContain('<p>hi</p>')
    expect(f.replyToMessageId).toBeUndefined()
  })
})

describe('compose helpers', () => {
  it('escapes and paragraphs plain text', () => {
    expect(textToHtml('a <b>\nc\n\nd')).toBe('<p>a &#60;b&#62;<br>c</p><p>d</p>')
  })

  it('parses typed addresses', () => {
    expect(parseAddresses('Ana <ana@a.com>, bo@b.com; nope')).toEqual([ana, { email: 'bo@b.com' }])
  })

  it('links the send to its saved draft only when one was saved', () => {
    const d = replyDraft(detail([msg('m1', {})]), 'reply', own)
    expect(toSendRequest(d, 10_000, false).draftId).toBeUndefined()
    expect(toSendRequest(d, 10_000, true)).toMatchObject({ draftId: d.id, undoMs: 10_000 })
  })
})
