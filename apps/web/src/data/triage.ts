import { invertOp, type FolderRow, type MailOp, type OpEnvelope } from '@zachmail/core'
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
  op: MailOp
  label: string
  model: ListModel | null
  removed: Removed[]
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
      this.done.push({ op, label, model, removed })
      if (this.done.length > UNDO_DEPTH) this.done.shift()
      this.show(label, true)
    }
    return removed
  }

  /** Reverts the latest op; rows it removed go back where they were, in the same frame. */
  undo(): Done | null {
    const d = this.done.pop()
    if (!d) return null
    const inverse = invertOp(d.op)
    if (d.model) {
      if (d.removed.length) d.model.restore(d.removed)
      else this.applyToModel(inverse, d.model)
    }
    this.send(inverse, `Undo ${d.label}`)
    this.show(`Undid: ${d.label}`, false)
    return d
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
      case 'inbox':
        // Where a returning thread sorts is the worker's call; its refresh follows at once.
        return []
    }
  }

  private show(text: string, undo: boolean, error = false) {
    clearTimeout(this.timer)
    this.toast = { key: ++this.key, text, undo, error }
    this.timer = setTimeout(this.dismiss, TOAST_MS)
    this.emit()
  }

  private emit() {
    for (const fn of this.listeners) fn()
  }
}
