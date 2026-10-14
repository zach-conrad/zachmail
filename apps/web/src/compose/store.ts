import type { ContactRow } from '@zachmail/core'
import type { DataClient } from '../data/client'
import { isEmpty, type Draft } from './draft'

const keyOf = (d: Draft) => (d.kind === 'new' ? 'new' : `thread:${d.threadId}`)

/**
 * Which composers are open (a sheet for new mail, one inline reply under the open thread) and
 * the drafts closed without sending, so `c` or `r` picks up where Esc left off.
 */
export class ComposeStore {
  sheet: Draft | null = null
  inline: Draft | null = null
  private kept = new Map<string, Draft>()
  private listeners = new Set<() => void>()
  private contacts: Promise<ContactRow[]> | null = null
  version = 0

  constructor(private client: DataClient) {}

  /** A draft closed earlier for this thread ('new' for the sheet). */
  resume(threadId: string | null): Draft | undefined {
    return this.kept.get(threadId ? `thread:${threadId}` : 'new')
  }

  open(d: Draft) {
    this.kept.delete(keyOf(d))
    if (d.kind === 'new' || d.sheet) this.sheet = d
    else {
      if (this.inline && this.inline.threadId !== d.threadId) this.keep(this.inline)
      this.inline = d
    }
    this.emit()
  }

  /** Closes a composer; `keep` remembers the draft (it is also saved to the provider). */
  close(d: Draft, keep: boolean) {
    if (keep) this.keep(d)
    else this.kept.delete(keyOf(d))
    if (this.sheet?.id === d.id) this.sheet = null
    if (this.inline?.id === d.id) this.inline = null
    this.emit()
  }

  /** Contacts for autocomplete, fetched once per session. */
  loadContacts(): Promise<ContactRow[]> {
    return (this.contacts ??= this.client.api.contacts().catch(() => {
      this.contacts = null
      return []
    }))
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = () => this.version

  private keep(d: Draft) {
    if (!isEmpty(d)) this.kept.set(keyOf(d), d)
  }

  private emit() {
    this.version++
    for (const fn of this.listeners) fn()
  }
}
