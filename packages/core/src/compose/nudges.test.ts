import { describe, expect, it } from 'vitest'
import type { MessageRow, ThreadRow } from '../sync/protocol'
import { DEFAULT_NUDGE_AFTER_MS, followUpNudge, followUpNudges } from './nudges'

const DAY = 86_400_000
const now = Date.parse('2026-10-14T12:00:00Z')

const thread = (id: string, at: number, over: Partial<ThreadRow> = {}): ThreadRow => ({
  id,
  accountId: 'a',
  subject: 's',
  snippet: '',
  participants: [],
  lastMessageAt: at,
  messageCount: 1,
  unread: false,
  starred: false,
  hasAttachments: false,
  folderIds: ['sent'],
  ...over,
})

const message = (threadId: string, at: number, over: Partial<MessageRow> = {}): MessageRow => ({
  id: `m-${threadId}-${at}`,
  threadId,
  accountId: 'a',
  from: { email: 'Zach@x.com' },
  to: [{ email: 'ana@y.com' }],
  cc: [],
  replyTo: [],
  subject: 's',
  snippet: 'Could you send the deck?',
  date: at,
  unread: false,
  starred: false,
  hasAttachments: false,
  listUnsubscribe: null,
  rfc822MessageId: null,
  bodyStatus: 'none',
  ...over,
})

const ctx = { ownEmails: new Set(['zach@x.com']), now }

describe('followUpNudge', () => {
  it('nudges an unanswered send after three days', () => {
    const sent = now - 4 * DAY
    const n = followUpNudge(
      thread('t', sent),
      [message('t', now - 9 * DAY, { from: { email: 'ana@y.com' } }), message('t', sent)],
      ctx,
    )
    expect(n).toEqual({
      threadId: 't',
      messageId: `m-t-${sent}`,
      sentAt: sent,
      waitingOn: [{ email: 'ana@y.com' }],
      dueAt: sent + DEFAULT_NUDGE_AFTER_MS,
    })
  })

  it('skips replies, closers, robots, mutes, trash, dismissed and too new or old', () => {
    const at = now - 4 * DAY
    const t = thread('t', at)
    const m = message('t', at)
    expect(
      followUpNudge(t, [m, message('t', at + 1, { from: { email: 'ana@y.com' } })], ctx),
    ).toBeNull()
    expect(followUpNudge(t, [{ ...m, snippet: 'Thanks so much!' }], ctx)).not.toBeNull()
    expect(followUpNudge(t, [{ ...m, snippet: 'Thanks!' }], ctx)).toBeNull()
    expect(followUpNudge(t, [{ ...m, snippet: 'Sounds good - Z' }], ctx)).toBeNull()
    expect(followUpNudge(t, [{ ...m, to: [{ email: 'no-reply@shop.com' }] }], ctx)).toBeNull()
    expect(followUpNudge({ ...t, muted: true }, [m], ctx)).toBeNull()
    expect(followUpNudge(t, [m], { ...ctx, skipFolderIds: new Set(['sent']) })).toBeNull()
    expect(followUpNudge(t, [m], { ...ctx, dismissals: new Map([['t', at]]) })).toBeNull()
    expect(followUpNudge(t, [m], { ...ctx, dismissals: new Map([['t', at - 1]]) })).not.toBeNull()
    expect(followUpNudge(t, [m], { ...ctx, skip: () => true })).toBeNull()
    expect(followUpNudge(thread('t', now - DAY), [message('t', now - DAY)], ctx)).toBeNull()
    expect(
      followUpNudge(thread('t', now - 40 * DAY), [message('t', now - 40 * DAY)], ctx),
    ).toBeNull()
    expect(followUpNudge(t, [m], { ...ctx }, { afterMs: 5 * DAY })).toBeNull()
  })
})

describe('followUpNudges', () => {
  it('orders by due date and only reads candidate threads', () => {
    const threads = [thread('a', now - 5 * DAY), thread('b', now - 4 * DAY), thread('c', now)]
    const read: string[] = []
    const out = followUpNudges(
      threads,
      (id) => {
        read.push(id)
        const t = threads.find((x) => x.id === id)!
        return [message(id, t.lastMessageAt)]
      },
      ctx,
    )
    expect(out.map((n) => n.threadId)).toEqual(['b', 'a'])
    expect(read).toEqual(['a', 'b'])
  })
})
