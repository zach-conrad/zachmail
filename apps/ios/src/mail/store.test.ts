import { openSqliteWasm } from '@zachmail/local-store/sqlite-wasm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { demoMailbox } from './fixture'
import { MailStore, parseAddresses, UNDO_MS, UNDO_SEND_MS, type MailState } from './store'

// The same SqlStore SQL as on device; sqlite-wasm stands in for expo-sqlite.
const NOW = Date.UTC(2026, 9, 13, 16, 0)
async function make() {
  const { driver } = await openSqliteWasm()
  const store = new MailStore(driver)
  const { rows, bodies } = demoMailbox(NOW)
  store.seed(rows, bodies)
  return store
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)
const inSplit = (store: MailStore, split: MailState['split']) =>
  ids(store.inbox({ ...store.getState(), split }))

describe('MailStore', () => {
  let store: MailStore
  beforeEach(async () => {
    store = await make()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('classifies the demo mailbox with the shared splits, newest first', () => {
    expect(inSplit(store, 'important')).toContain('t1') // Ana, Gmail-important
    expect(inSplit(store, 'notifications')).toEqual(expect.arrayContaining(['t3', 't4'])) // Stripe, GitHub
    expect(inSplit(store, 'newsletters')).toContain('t8')
    expect(inSplit(store, 'other')).toContain('t7') // new human sender
    const important = store.inbox(store.getState())
    const times = important.map((t) => t.lastMessageAt)
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('done leaves the inbox in the same call, and undo brings it back', () => {
    store.run({ kind: 'done', threadId: 't1' })
    expect(inSplit(store, 'important')).not.toContain('t1')
    expect(ids(store.done(store.getState()))).toContain('t1')
    expect(store.getState().toast?.label).toBe('Marked done')
    store.undoToast()
    expect(inSplit(store, 'important')).toContain('t1')
    expect(store.getState().toast).toBeNull()
  })

  it('every write bumps the version screens re-query on', () => {
    const v = store.getState().version
    store.run({ kind: 'star', threadId: 't1' })
    expect(store.getState().version).toBeGreaterThan(v)
  })

  it('toast expires after the undo window', () => {
    store.run({ kind: 'trash', threadId: 't2' })
    vi.advanceTimersByTime(UNDO_MS)
    expect(store.getState().toast).toBeNull()
  })

  it('trash moves to the trash folder and out of Done', () => {
    store.run({ kind: 'trash', threadId: 't2' })
    expect(store.thread(store.getState(), 't2')!.thread.folderIds).toContain('acc-personal:trash')
    expect(ids(store.done(store.getState()))).not.toContain('t2')
  })

  it('snooze parks a thread in Reminders until wake()', () => {
    store.run({ kind: 'snooze', threadId: 't5', until: NOW + 1000 })
    expect(store.reminders(store.getState()).map((r) => r.thread.id)).toEqual(['t5'])
    expect(inSplit(store, 'important')).not.toContain('t5')
    expect(ids(store.done(store.getState()))).not.toContain('t5')
    store.wake(NOW + 1000)
    expect(store.reminders(store.getState())).toEqual([])
    expect(inSplit(store, 'important')).toContain('t5')
  })

  it('toggleRead flips the thread and the split counts', () => {
    const before = store.splitCounts(store.getState()).important
    store.run({ kind: 'toggleRead', threadId: 't1' })
    expect(store.thread(store.getState(), 't1')!.thread.unread).toBe(false)
    expect(store.splitCounts(store.getState()).important).toBe(before - 1)
  })

  it('scope filters to one account', () => {
    store.setScope('acc-work')
    expect(store.inbox(store.getState()).every((t) => t.accountId === 'acc-work')).toBe(true)
  })

  it('auto-advance finds the next inbox thread', () => {
    const list = inSplit(store, 'important')
    expect(store.nextInInbox(store.getState(), list[0]!)).toBe(list[1])
    expect(store.nextInInbox(store.getState(), list.at(-1)!)).toBeUndefined()
  })

  it('send waits out the undo window, then joins the thread', () => {
    const count = () => store.thread(store.getState(), 't2')!.messages.length
    const before = count()
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
    expect(count()).toBe(before)
    vi.advanceTimersByTime(UNDO_SEND_MS)
    expect(count()).toBe(before + 1)
    const d = store.thread(store.getState(), 't2')!
    expect(d.thread.snippet).toBe('See you then')
    expect(d.bodies[d.messages.at(-1)!.id]?.html).toBe('<p>See you then</p>')
  })

  it('undo send hands the draft back and never sends', () => {
    const onUndo = vi.fn()
    store.send(
      { accountId: 'acc-dev', to: 'sam@okafor.design', cc: '', subject: 'Logos', body: 'Love #2' },
      onUndo,
    )
    store.undoToast()
    vi.advanceTimersByTime(UNDO_SEND_MS)
    expect(onUndo).toHaveBeenCalledWith(expect.objectContaining({ body: 'Love #2' }))
    expect(store.search(store.getState(), 'logos love')).toEqual([])
  })

  it('searches subject, snippet and people, treating LIKE wildcards literally', () => {
    expect(ids(store.search(store.getState(), 'ana q4'))).toEqual(['t1'])
    expect(store.search(store.getState(), '')).toEqual([])
    expect(ids(store.search(store.getState(), '4.2%'))).toEqual(['t13']) // literal %
    expect(store.search(store.getState(), 'q_')).toEqual([]) // _ is not a wildcard
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
