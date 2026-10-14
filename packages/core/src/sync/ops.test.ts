import { describe, expect, it } from 'vitest'
import {
  InvalidOpsError,
  applyEffect,
  invertOp,
  opEffect,
  parseOpsRequest,
  type FolderOfKind,
  type MailOp,
} from './ops'
import type { ThreadRow } from './protocol'

const F = { inbox: 'f-inbox', trash: 'f-trash', spam: 'f-spam', starred: 'f-star' } as const
const folderOf: FolderOfKind = (k) => (F as Record<string, string>)[k]
const T1 = '00000000-0000-4000-8000-000000000001'
const L1 = '00000000-0000-4000-8000-0000000000a1'

const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({
  id: T1,
  accountId: 'a',
  subject: 's',
  snippet: '',
  participants: [],
  lastMessageAt: 0,
  messageCount: 1,
  unread: true,
  starred: false,
  hasAttachments: false,
  folderIds: [F.inbox],
  ...over,
})

const run = (op: MailOp, t = thread()) => applyEffect(t, opEffect(op, folderOf))

describe('ops', () => {
  it('archives, trashes and restores through folder ids', () => {
    expect(run({ kind: 'archive', threadIds: [T1] }).folderIds).toEqual([])
    expect(run({ kind: 'trash', threadIds: [T1] }).folderIds).toEqual([F.trash])
    const trashed = thread({ folderIds: [F.trash] })
    expect(run({ kind: 'inbox', threadIds: [T1] }, trashed).folderIds).toEqual([F.inbox])
  })

  it('sets flags and the starred folder', () => {
    const t = run({ kind: 'star', threadIds: [T1] })
    expect(t).toMatchObject({ starred: true, folderIds: [F.inbox, F.starred] })
    expect(run({ kind: 'read', threadIds: [T1] }).unread).toBe(false)
  })

  it('returns the same object when nothing changes', () => {
    const t = thread({ unread: false })
    expect(run({ kind: 'read', threadIds: [T1] }, t)).toBe(t)
  })

  it('ignores kinds the account has no folder for', () => {
    const none: FolderOfKind = () => undefined
    expect(opEffect({ kind: 'archive', threadIds: [T1] }, none)).toEqual({
      add: [],
      remove: [],
      snoozedUntil: null,
    })
  })

  it('snoozes out of the inbox and wakes back into it, unread', () => {
    const snoozed = run({ kind: 'snooze', threadIds: [T1], until: 5000 }, thread({ unread: false }))
    expect(snoozed).toMatchObject({ folderIds: [], snoozedUntil: 5000, unread: false })
    const woke = run({ kind: 'unsnooze', threadIds: [T1] }, snoozed)
    expect(woke).toMatchObject({
      folderIds: [F.inbox],
      unread: true,
      snoozedUntil: null,
      reminder: null,
    })
    // Undo of a snooze, or marking it done, ends the snooze without marking it unread.
    expect(invertOp({ kind: 'snooze', threadIds: [T1], until: 5000 }).kind).toBe('inbox')
    expect(run({ kind: 'inbox', threadIds: [T1] }, snoozed)).toMatchObject({
      folderIds: [F.inbox],
      unread: false,
      snoozedUntil: null,
    })
    expect(run({ kind: 'archive', threadIds: [T1] }, snoozed).snoozedUntil).toBeNull()
  })

  it('sets and clears reminders without touching folders', () => {
    const op: MailOp = { kind: 'remind', threadIds: [T1], at: 9000, condition: 'if_no_reply' }
    const t = run(op)
    expect(t).toMatchObject({
      folderIds: [F.inbox],
      reminder: { at: 9000, condition: 'if_no_reply' },
    })
    expect(run(op, t)).toBe(t)
    expect(run({ kind: 'unremind', threadIds: [T1] }, t).reminder).toBeNull()
    expect(invertOp(op)).toEqual({ kind: 'unremind', threadIds: [T1] })
    // Rows from servers that predate snooze have neither field; nothing changes for them.
    const plain = thread()
    expect(run({ kind: 'unremind', threadIds: [T1] }, plain)).toBe(plain)
  })

  it('inverts ops', () => {
    expect(invertOp({ kind: 'archive', threadIds: [T1] })).toEqual({
      kind: 'inbox',
      threadIds: [T1],
    })
    expect(invertOp({ kind: 'label', threadIds: [T1], add: [L1], remove: [] })).toEqual({
      kind: 'label',
      threadIds: [T1],
      add: [],
      remove: [L1],
    })
  })

  it('validates request bodies', () => {
    const ok = { ops: [{ id: T1, at: 1, op: { kind: 'archive', threadIds: [T1] } }] }
    expect(parseOpsRequest(ok).ops[0]!.op.kind).toBe('archive')
    const label = {
      ops: [{ id: T1, at: 1, op: { kind: 'label', threadIds: [T1], add: [L1], remove: [] } }],
    }
    expect(parseOpsRequest(label).ops[0]!.op).toMatchObject({ add: [L1] })
    const env = (op: Record<string, unknown>) => ({ ops: [{ id: T1, at: 1, op }] })
    expect(parseOpsRequest(env({ kind: 'snooze', threadIds: [T1], until: 2 })).ops[0]!.op).toEqual({
      kind: 'snooze',
      threadIds: [T1],
      until: 2,
    })
    expect(
      parseOpsRequest(env({ kind: 'remind', threadIds: [T1], at: 2, condition: 'always' })).ops[0]!
        .op,
    ).toEqual({ kind: 'remind', threadIds: [T1], at: 2, condition: 'always' })
    expect(parseOpsRequest(env({ kind: 'unsnooze', threadIds: [T1] })).ops[0]!.op.kind).toBe(
      'unsnooze',
    )
    expect(() => parseOpsRequest(env({ kind: 'snooze', threadIds: [T1] }))).toThrow(/until/)
    expect(() =>
      parseOpsRequest(env({ kind: 'snooze', threadIds: [T1], until: Date.now() * 2 })),
    ).toThrow(/5 years/)
    expect(() =>
      parseOpsRequest(env({ kind: 'remind', threadIds: [T1], at: 2, condition: 'maybe' })),
    ).toThrow(/condition/)
    expect(() => parseOpsRequest({})).toThrow(InvalidOpsError)
    expect(() => parseOpsRequest({ ops: [{ id: 'x', at: 1, op: ok.ops[0]!.op }] })).toThrow(/id/)
    expect(() =>
      parseOpsRequest({ ops: [{ id: T1, at: 1, op: { kind: 'nuke', threadIds: [T1] } }] }),
    ).toThrow(/kind/)
    expect(() =>
      parseOpsRequest({ ops: [{ id: T1, at: 1, op: { kind: 'read', threadIds: [] } }] }),
    ).toThrow(/threadIds/)
  })
})
