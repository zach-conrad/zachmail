import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { demoMailbox } from './fixture'
import {
  doneThreads,
  inboxThreads,
  MailStore,
  parseAddresses,
  reminderThreads,
  searchThreads,
  splitCounts,
  threadSplits,
  UNDO_MS,
  UNDO_SEND_MS,
} from './store'

const NOW = Date.UTC(2026, 9, 13, 16, 0)
const make = () => {
  const { rows, bodies } = demoMailbox(NOW)
  return new MailStore(rows, bodies)
}

describe('MailStore', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sorts each split newest first and classifies the demo mailbox', () => {
    const s = make().getState()
    const splits = threadSplits(s)
    expect(splits.get('t1')).toBe('important') // Ana, Zach wrote to her
    expect(splits.get('t3')).toBe('notifications') // Stripe receipt
    expect(splits.get('t4')).toBe('notifications') // GitHub
    expect(splits.get('t8')).toBe('newsletters')
    expect(splits.get('t7')).toBe('other') // new human sender
    const important = inboxThreads(s, 'important')
    expect(important.map((t) => t.lastMessageAt)).toEqual(
      [...important.map((t) => t.lastMessageAt)].sort((a, b) => b - a),
    )
  })

  it('done removes from the inbox in the same call and undo restores it', () => {
    const store = make()
    store.run({ kind: 'done', threadId: 't1' })
    expect(inboxThreads(store.getState(), 'important').some((t) => t.id === 't1')).toBe(false)
    expect(doneThreads(store.getState()).some((t) => t.id === 't1')).toBe(true)
    expect(store.getState().toast?.label).toBe('Marked done')
    store.undoToast()
    expect(inboxThreads(store.getState(), 'important').some((t) => t.id === 't1')).toBe(true)
    expect(store.getState().toast).toBeNull()
  })

  it('toast expires after the undo window', () => {
    const store = make()
    store.run({ kind: 'trash', threadId: 't2' })
    vi.advanceTimersByTime(UNDO_MS)
    expect(store.getState().toast).toBeNull()
  })

  it('trash moves to the trash folder and out of Done', () => {
    const store = make()
    store.run({ kind: 'trash', threadId: 't2' })
    const t = store.getState().threads.t2!
    expect(t.folderIds).toContain('acc-personal:trash')
    expect(doneThreads(store.getState()).some((x) => x.id === 't2')).toBe(false)
  })

  it('snooze parks a thread in Reminders until wake()', () => {
    const store = make()
    store.run({ kind: 'snooze', threadId: 't5', until: NOW + 1000 })
    expect(reminderThreads(store.getState()).map((r) => r.thread.id)).toEqual(['t5'])
    expect(inboxThreads(store.getState(), 'important').some((t) => t.id === 't5')).toBe(false)
    store.wake(NOW + 1000)
    expect(reminderThreads(store.getState())).toEqual([])
    expect(inboxThreads(store.getState(), 'important')[0]?.id).toBe('t5')
  })

  it('toggleRead flips the thread and updates split counts', () => {
    const store = make()
    const before = splitCounts(store.getState()).important
    store.run({ kind: 'toggleRead', threadId: 't1' })
    expect(store.getState().threads.t1!.unread).toBe(false)
    expect(splitCounts(store.getState()).important).toBe(before - 1)
  })

  it('scope filters to one account', () => {
    const store = make()
    store.setScope('acc-work')
    expect(
      inboxThreads(store.getState(), 'important').every((t) => t.accountId === 'acc-work'),
    ).toBe(true)
  })

  it('send waits out the undo window, then joins the thread', () => {
    const store = make()
    const before = store.getState().messages.t2!.length
    store.send(
      {
        accountId: 'acc-personal',
        to: 'jordan.lee@gmail.com',
        cc: '',
        subject: 'Re: dinner Friday',
        body: 'See you then',
        threadId: 't2',
      },
      () => {},
    )
    expect(store.getState().messages.t2!.length).toBe(before)
    vi.advanceTimersByTime(UNDO_SEND_MS)
    expect(store.getState().messages.t2!.length).toBe(before + 1)
    expect(store.getState().threads.t2!.snippet).toBe('See you then')
  })

  it('undo send hands the draft back and never sends', () => {
    const store = make()
    const onUndo = vi.fn()
    store.send(
      { accountId: 'acc-dev', to: 'sam@okafor.design', cc: '', subject: 'Logos', body: 'Love #2' },
      onUndo,
    )
    store.undoToast()
    vi.advanceTimersByTime(UNDO_SEND_MS)
    expect(onUndo).toHaveBeenCalledWith(expect.objectContaining({ body: 'Love #2' }))
    expect(Object.values(store.getState().threads).some((t) => t.subject === 'Logos')).toBe(false)
  })

  it('searches subject, snippet and people', () => {
    const s = make().getState()
    expect(searchThreads(s, 'ana q4').map((t) => t.id)).toEqual(['t1'])
    expect(searchThreads(s, '')).toEqual([])
  })
})

describe('parseAddresses', () => {
  it('reads plain and named addresses', () => {
    expect(parseAddresses('a@x.com, "Ana Ruiz" <ana@acme.co>')).toEqual([
      { email: 'a@x.com' },
      { name: 'Ana Ruiz', email: 'ana@acme.co' },
    ])
  })
})
