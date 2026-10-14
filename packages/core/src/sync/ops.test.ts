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

  it('mutes by archiving and flagging, and unmutes back into the inbox', () => {
    const muted = run({ kind: 'mute', threadIds: [T1] })
    expect(muted).toMatchObject({ folderIds: [], muted: true })
    expect(run(invertOp({ kind: 'mute', threadIds: [T1] }), muted)).toMatchObject({
      folderIds: [F.inbox],
      muted: false,
    })
  })

  it('returns the same object when nothing changes', () => {
    const t = thread({ unread: false })
    expect(run({ kind: 'read', threadIds: [T1] }, t)).toBe(t)
  })

  it('ignores kinds the account has no folder for', () => {
    const none: FolderOfKind = () => undefined
    expect(opEffect({ kind: 'archive', threadIds: [T1] }, none)).toEqual({ add: [], remove: [] })
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
