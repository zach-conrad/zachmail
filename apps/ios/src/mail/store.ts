/**
 * The iOS mail replica. Every action applies to local state synchronously and returns its inverse,
 * so the UI updates in the same frame and every triage verb gets Undo (design §3.1, architecture §1a).
 * For now it holds the demo fixture in memory; the expo-sqlite replica and core sync client replace
 * the storage behind this same interface. No React Native imports, so it's unit-tested directly.
 */
import type {
  AccountRow,
  Address,
  FolderKind,
  FolderRow,
  MessageBody,
  MessageRow,
  Rows,
  ThreadRow,
} from '@zachmail/core'
import { classify, splitContext, type SplitId } from './splits'

export type Scope = 'all' | string

export interface Draft {
  accountId: string
  to: string
  cc: string
  subject: string
  body: string
  /** Set when replying or forwarding. */
  threadId?: string
}

export interface Toast {
  id: number
  label: string
  /** Runs the inverse; absent for toasts without Undo. */
  undo?: () => void
}

export interface MailState {
  accounts: AccountRow[]
  folders: FolderRow[]
  threads: Record<string, ThreadRow>
  messages: Record<string, MessageRow[]>
  bodies: Record<string, MessageBody>
  /** ZachMail-only reminders: threadId → due time (null = someday). */
  snoozes: Record<string, number | null>
  scope: Scope
  split: SplitId
  toast: Toast | null
  /** Sends waiting out the undo-send window. */
  pending: Record<number, Draft>
}

export type Command =
  | { kind: 'done'; threadId: string }
  | { kind: 'undone'; threadId: string }
  | { kind: 'trash'; threadId: string }
  | { kind: 'snooze'; threadId: string; until: number | null }
  | { kind: 'toggleRead'; threadId: string }
  | { kind: 'markRead'; threadId: string }
  | { kind: 'star'; threadId: string }

const TOAST_LABEL: Partial<Record<Command['kind'], string>> = {
  done: 'Marked done',
  undone: 'Moved to inbox',
  trash: 'Moved to trash',
  snooze: 'Reminder set',
}

export const UNDO_MS = 6_000
export const UNDO_SEND_MS = 10_000

type Listener = () => void

export class MailStore {
  private state: MailState
  private listeners = new Set<Listener>()
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private sendTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private seq = 0
  private folderIndex = new Map<string, string>()

  constructor(rows: Rows, bodies: Record<string, MessageBody> = {}) {
    const messages: Record<string, MessageRow[]> = {}
    for (const m of [...rows.messages].sort((a, b) => a.date - b.date))
      (messages[m.threadId] ??= []).push(m)
    for (const f of rows.folders)
      if (f.kind !== 'custom') this.folderIndex.set(`${f.accountId}:${f.kind}`, f.id)
    this.state = {
      accounts: rows.accounts,
      folders: rows.folders,
      threads: Object.fromEntries(rows.threads.map((t) => [t.id, t])),
      messages,
      bodies,
      snoozes: {},
      scope: 'all',
      split: 'important',
      toast: null,
      pending: {},
    }
  }

  getState = (): MailState => this.state

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<MailState>) {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  folderId(accountId: string, kind: FolderKind): string | undefined {
    return this.folderIndex.get(`${accountId}:${kind}`)
  }

  setScope(scope: Scope) {
    this.set({ scope })
  }

  setSplit(split: SplitId) {
    this.set({ split })
  }

  /** Apply a command locally; returns the inverse. Shows an Undo toast for list-removing verbs. */
  run(cmd: Command): () => void {
    const before = this.state.threads[cmd.threadId]
    if (!before) return () => {}
    const prevSnooze =
      cmd.threadId in this.state.snoozes ? this.state.snoozes[cmd.threadId] : undefined
    const prevMessages = this.state.messages[cmd.threadId]
    const next = this.apply(before, cmd)
    const snoozes = { ...this.state.snoozes }
    if (cmd.kind === 'snooze') snoozes[cmd.threadId] = cmd.until
    else if (cmd.kind === 'done' || cmd.kind === 'trash' || cmd.kind === 'undone')
      delete snoozes[cmd.threadId]

    let messages = this.state.messages
    if (cmd.kind === 'toggleRead' || cmd.kind === 'markRead') {
      messages = {
        ...messages,
        [cmd.threadId]: (prevMessages ?? []).map((m) => ({
          ...m,
          unread: next.unread && m === prevMessages?.at(-1),
        })),
      }
    }
    this.set({ threads: { ...this.state.threads, [cmd.threadId]: next }, snoozes, messages })

    const undo = () => {
      const s = { ...this.state.snoozes }
      if (prevSnooze === undefined) delete s[cmd.threadId]
      else s[cmd.threadId] = prevSnooze
      const msgs = prevMessages
        ? { ...this.state.messages, [cmd.threadId]: prevMessages }
        : this.state.messages
      this.set({
        threads: { ...this.state.threads, [cmd.threadId]: before },
        snoozes: s,
        messages: msgs,
      })
    }
    const label = TOAST_LABEL[cmd.kind]
    if (label) this.showToast(label, undo)
    return undo
  }

  private apply(t: ThreadRow, cmd: Command): ThreadRow {
    const inbox = this.folderId(t.accountId, 'inbox')
    const trash = this.folderId(t.accountId, 'trash')
    const without = (...ids: (string | undefined)[]) => t.folderIds.filter((f) => !ids.includes(f))
    switch (cmd.kind) {
      case 'done':
      case 'snooze':
        return { ...t, folderIds: without(inbox) }
      case 'undone':
        return { ...t, folderIds: [...without(inbox, trash), ...(inbox ? [inbox] : [])] }
      case 'trash':
        return {
          ...t,
          folderIds: [...without(inbox), ...(trash && !t.folderIds.includes(trash) ? [trash] : [])],
        }
      case 'toggleRead':
        return { ...t, unread: !t.unread }
      case 'markRead':
        return t.unread ? { ...t, unread: false } : t
      case 'star':
        return { ...t, starred: !t.starred }
    }
  }

  /** Return due reminders to the inbox (design §3.6). Call on foreground and on a timer. */
  wake(now: number) {
    const due = Object.entries(this.state.snoozes).filter(
      ([, until]) => until !== null && until <= now,
    )
    if (!due.length) return
    const threads = { ...this.state.threads }
    const snoozes = { ...this.state.snoozes }
    for (const [id] of due) {
      const t = threads[id]
      delete snoozes[id]
      const inbox = t && this.folderId(t.accountId, 'inbox')
      if (t && inbox && !t.folderIds.includes(inbox))
        threads[id] = { ...t, folderIds: [...t.folderIds, inbox], lastMessageAt: now }
    }
    this.set({ threads, snoozes })
  }

  showToast(label: string, undo?: () => void, ms = UNDO_MS) {
    clearTimeout(this.toastTimer)
    const id = ++this.seq
    this.set({ toast: { id, label, ...(undo ? { undo } : {}) } })
    this.toastTimer = setTimeout(() => this.dismissToast(id), ms)
  }

  dismissToast(id?: number) {
    if (!this.state.toast || (id !== undefined && this.state.toast.id !== id)) return
    clearTimeout(this.toastTimer)
    this.set({ toast: null })
  }

  /** Undo the toast's action, if any. */
  undoToast() {
    const t = this.state.toast
    if (!t?.undo) return
    this.dismissToast(t.id)
    t.undo()
  }

  /**
   * Queue a send behind the undo window (design §3.4). `onUndo` gets the draft back so the composer
   * can reopen it. The real client hands the draft to the outbox when the window closes.
   */
  send(draft: Draft, onUndo: (d: Draft) => void): number {
    const id = ++this.seq
    this.set({ pending: { ...this.state.pending, [id]: draft } })
    this.sendTimers.set(
      id,
      setTimeout(() => this.commitSend(id, Date.now()), UNDO_SEND_MS),
    )
    this.showToast(
      'Sending…',
      () => {
        const d = this.cancelSend(id)
        if (d) onUndo(d)
      },
      UNDO_SEND_MS,
    )
    return id
  }

  cancelSend(id: number): Draft | undefined {
    const d = this.state.pending[id]
    clearTimeout(this.sendTimers.get(id))
    this.sendTimers.delete(id)
    if (!d) return undefined
    const pending = { ...this.state.pending }
    delete pending[id]
    this.set({ pending })
    return d
  }

  /** Close the undo window: the sent message joins its thread (or starts one) locally. */
  commitSend(id: number, now: number) {
    const d = this.cancelSend(id)
    const acc = d && this.state.accounts.find((a) => a.id === d.accountId)
    if (!d || !acc) return
    const threadId = d.threadId ?? `local-${id}`
    const from: Address = { name: acc.displayName ?? undefined, email: acc.email }
    const to = parseAddresses(d.to)
    const msg: MessageRow = {
      id: `${threadId}-sent-${id}`,
      threadId,
      accountId: acc.id,
      from,
      to,
      cc: parseAddresses(d.cc),
      replyTo: [],
      subject: d.subject,
      snippet: d.body.slice(0, 120),
      date: now,
      unread: false,
      starred: false,
      hasAttachments: false,
      listUnsubscribe: null,
      rfc822MessageId: null,
      bodyStatus: 'cached',
    }
    const sent = this.folderId(acc.id, 'sent')
    const prev = this.state.threads[threadId]
    const thread: ThreadRow = prev
      ? {
          ...prev,
          snippet: msg.snippet,
          lastMessageAt: now,
          messageCount: prev.messageCount + 1,
          folderIds:
            sent && !prev.folderIds.includes(sent) ? [...prev.folderIds, sent] : prev.folderIds,
        }
      : {
          id: threadId,
          accountId: acc.id,
          subject: d.subject,
          snippet: msg.snippet,
          participants: [from, ...to],
          lastMessageAt: now,
          messageCount: 1,
          unread: false,
          starred: false,
          hasAttachments: false,
          folderIds: sent ? [sent] : [],
        }
    this.set({
      threads: { ...this.state.threads, [threadId]: thread },
      messages: {
        ...this.state.messages,
        [threadId]: [...(this.state.messages[threadId] ?? []), msg],
      },
      bodies: {
        ...this.state.bodies,
        [msg.id]: { messageId: msg.id, html: escapeHtml(d.body), hasRemoteImages: false },
      },
    })
  }
}

export function parseAddresses(s: string): Address[] {
  return s
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(.*)<([^>]+)>$/.exec(x)
      return m
        ? { name: m[1]!.trim().replace(/^"|"$/g, '') || undefined, email: m[2]!.trim() }
        : { email: x }
    })
}

const escapeHtml = (s: string) =>
  `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`

// ── Selectors ────────────────────────────────────────────────────────────────────────────────────

const byNewest = (a: ThreadRow, b: ThreadRow) => b.lastMessageAt - a.lastMessageAt

function folderKinds(s: MailState): Map<string, FolderKind> {
  return new Map(s.folders.map((f) => [f.id, f.kind]))
}

const inScope = (s: MailState, t: ThreadRow) => s.scope === 'all' || t.accountId === s.scope

const splitCache = new WeakMap<MailState['threads'], Map<string, SplitId>>()

/** Split per thread, computed once per threads snapshot. */
export function threadSplits(s: MailState): Map<string, SplitId> {
  let out = splitCache.get(s.threads)
  if (out) return out
  const ctx = splitContext(
    s.accounts.map((a) => a.email),
    Object.values(s.messages).flat(),
  )
  out = new Map(
    Object.values(s.threads).map((t) => [t.id, classify(t, s.messages[t.id] ?? [], ctx)]),
  )
  splitCache.set(s.threads, out)
  return out
}

function inboxAll(s: MailState): ThreadRow[] {
  const kinds = folderKinds(s)
  return Object.values(s.threads).filter(
    (t) => inScope(s, t) && t.folderIds.some((f) => kinds.get(f) === 'inbox'),
  )
}

export function inboxThreads(s: MailState, split: SplitId = s.split): ThreadRow[] {
  const splitsOf = threadSplits(s)
  return inboxAll(s)
    .filter((t) => splitsOf.get(t.id) === split)
    .sort(byNewest)
}

/** Unread inbox threads per split, for the split switcher. */
export function splitCounts(s: MailState): Record<SplitId, number> {
  const splitsOf = threadSplits(s)
  const out: Record<SplitId, number> = { important: 0, other: 0, newsletters: 0, notifications: 0 }
  for (const t of inboxAll(s)) if (t.unread) out[splitsOf.get(t.id)!]++
  return out
}

export function doneThreads(s: MailState): ThreadRow[] {
  const kinds = folderKinds(s)
  const hidden = new Set<FolderKind>(['inbox', 'trash', 'spam', 'drafts'])
  return Object.values(s.threads)
    .filter(
      (t) =>
        inScope(s, t) &&
        !(t.id in s.snoozes) &&
        !t.folderIds.some((f) => hidden.has(kinds.get(f)!)),
    )
    .sort(byNewest)
}

export function reminderThreads(s: MailState): { thread: ThreadRow; until: number | null }[] {
  return Object.entries(s.snoozes)
    .map(([id, until]) => ({ thread: s.threads[id]!, until }))
    .filter((r) => r.thread && inScope(s, r.thread))
    .sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity))
}

/** Local search over subject, snippet and participants (design §3.5; operators come with SQLite FTS). */
export function searchThreads(s: MailState, query: string): ThreadRow[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return Object.values(s.threads)
    .filter((t) => {
      const hay =
        `${t.subject} ${t.snippet} ${t.participants.map((p) => `${p.name ?? ''} ${p.email}`).join(' ')}`.toLowerCase()
      return terms.every((term) => hay.includes(term))
    })
    .sort(byNewest)
}

export function accountById(s: MailState, id: string): AccountRow | undefined {
  return s.accounts.find((a) => a.id === id)
}
