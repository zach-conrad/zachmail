import {
  invertOp,
  type FolderRow,
  type MailOp,
  type OpEnvelope,
  type SendRequest,
} from '@zachmail/core'
import type { DataClient } from './client'
import type { ListModel, Removed } from './listModel'

export interface Toast {
  key: number
  text: string
  /** Shows "Undo (Z)". */
  undo: boolean
  error: boolean
}

interface Done {
  label: string
  model: ListModel | null
  removed: Removed[]
  /** Sends whatever undoes it (the inverse op, or DELETE /api/send/:id). */
  revert: () => void
}

const TOAST_MS = 6000
const UNDO_DEPTH = 20

/**
 * Runs triage ops on the main thread: the visible list changes in the same frame, then the op
 * goes to the worker, which persists, overlays and sends it. Keeps the undo stack and toast.
 */
export class Triage {
  toast: Toast | null = null
  folders: FolderRow[] = []
  private inboxIds = new Set<string>()
  private done: Done[] = []
  private labels = new Map<string, string>()
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private key = 0

  constructor(private client: DataClient) {
    let last = ''
    const load = () =>
      void client.api.folders().then((rows) => {
        const k = JSON.stringify(rows)
        if (k === last) return
        last = k
        this.folders = rows
        this.inboxIds = new Set(rows.filter((f) => f.kind === 'inbox').map((f) => f.id))
      })
    load()
    client.subscribe((e) => {
      if (e.type === 'changed') load()
      else if (e.type === 'opFailed') {
        const what = this.labels.get(e.id)
        this.show(what ? `Couldn't apply “${what}”: ${e.error}` : e.error, false, true)
      }
    })
  }

  /**
   * Applies `op` to `model` now (rows leaving the view vanish; read and star flip in place)
   * and queues it. `label` is the toast text; `quiet` ops (mark read on open) show nothing and
   * can't be undone.
   */
  run(op: MailOp, label: string, model: ListModel | null, quiet = false): Removed[] {
    const removed = model ? this.applyToModel(op, model) : []
    this.send(op, label)
    if (!quiet) {
      this.push({ label, model, removed, revert: () => this.revertOp(op, model, removed, label) })
      this.show(label, true)
    }
    return removed
  }

  /** Reverts the latest action; rows it removed go back where they were, in the same frame. */
  undo(): Done | null {
    const d = this.done.pop()
    d?.revert()
    return d ?? null
  }

  /**
   * Queues a message; the server sends it once the undo window has passed. Undo (Z or the
   * toast) cancels it and hands the draft back through `reopen`, as does a failed request.
   */
  sendMail(req: SendRequest, label: string, reopen: () => void) {
    this.labels.set(req.id, label)
    let cancelled = false
    this.client.api.send(req).catch((err: unknown) => {
      if (cancelled) return
      this.done = this.done.filter((d) => d.label !== label)
      this.show(`Couldn't send: ${err instanceof Error ? err.message : String(err)}`, false, true)
      reopen()
    })
    const revert = () => {
      cancelled = true
      void this.client.api.unsend(req.id).then(
        (ok) => {
          if (ok) {
            this.show('Sending undone', false)
            reopen()
          } else this.show('Too late to undo: it has been sent', false, true)
        },
        () => this.show("Couldn't undo the send", false, true),
      )
    }
    this.push({ label, model: null, removed: [], revert })
    this.show(label, true, false, req.undoMs ?? TOAST_MS)
  }

  private push(d: Done) {
    this.done.push(d)
    if (this.done.length > UNDO_DEPTH) this.done.shift()
  }

  private revertOp(op: MailOp, model: ListModel | null, removed: Removed[], label: string) {
    const inverse = invertOp(op)
    if (model) {
      if (removed.length) model.restore(removed)
      else this.applyToModel(inverse, model)
    }
    this.send(inverse, `Undo ${label}`)
    this.show(`Undid: ${label}`, false)
  }

  dismiss = () => {
    clearTimeout(this.timer)
    this.toast = null
    this.emit()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getToast = () => this.toast

  private send(op: MailOp, label: string) {
    const env: OpEnvelope = { id: crypto.randomUUID(), op, at: Date.now() }
    this.labels.set(env.id, label)
    this.client.op(env)
  }

  private applyToModel(op: MailOp, model: ListModel): Removed[] {
    const ids = new Set(op.threadIds)
    switch (op.kind) {
      case 'archive':
      case 'trash':
      case 'spam':
      case 'mute':
      case 'snooze':
        return model.remove(ids)
      case 'label':
        if (op.remove.some((id) => this.inboxIds.has(id))) return model.remove(ids)
        model.patch(ids, (t) => ({
          ...t,
          folderIds: [...new Set([...t.folderIds, ...op.add])].filter(
            (f) => !op.remove.includes(f),
          ),
        }))
        return []
      case 'read':
      case 'unread':
        model.patch(ids, (t) => ({ ...t, unread: op.kind === 'unread' }))
        return []
      case 'star':
      case 'unstar':
        model.patch(ids, (t) => ({ ...t, starred: op.kind === 'star' }))
        return []
      case 'remind':
      case 'unremind':
        return []
      case 'inbox':
      case 'unmute':
      case 'unsnooze':
        // Where a returning thread sorts is the worker's call; its refresh follows at once.
        return []
    }
  }

  private show(text: string, undo: boolean, error = false, ms = TOAST_MS) {
    clearTimeout(this.timer)
    this.toast = { key: ++this.key, text, undo, error }
    this.timer = setTimeout(this.dismiss, ms)
    this.emit()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}
