/**
 * The one keymap registry (design spec §4). The key handler, the ⌘K palette, the `?` cheat
 * sheet and the macOS menu bar all read from here so they never drift.
 *
 * Key syntax: space-separated steps for sequences ("g i"); each step is modifiers joined with
 * "+" then the key ("mod+k", "shift+e", "#"). "mod" is ⌘ on Apple platforms and Ctrl elsewhere.
 */

export type Platform = 'web' | 'macos' | 'ios'
export type CommandGroup = 'navigation' | 'triage' | 'compose' | 'selection' | 'app'

export interface KeyBinding {
  id: string
  label: string
  group: CommandGroup
  keys: string[]
  platforms?: Platform[]
}

export const keymap = [
  // Navigation
  { id: 'nav.next', label: 'Next thread', group: 'navigation', keys: ['j'] },
  { id: 'nav.prev', label: 'Previous thread', group: 'navigation', keys: ['k'] },
  { id: 'nav.open', label: 'Open thread', group: 'navigation', keys: ['enter', 'o'] },
  { id: 'nav.back', label: 'Back', group: 'navigation', keys: ['escape'] },
  { id: 'nav.nextMessage', label: 'Next message', group: 'navigation', keys: ['n'] },
  { id: 'nav.prevMessage', label: 'Previous message', group: 'navigation', keys: ['p'] },
  { id: 'nav.expandAll', label: 'Expand all messages', group: 'navigation', keys: [';'] },
  { id: 'nav.nextSplit', label: 'Next split', group: 'navigation', keys: ['tab'] },
  { id: 'nav.prevSplit', label: 'Previous split', group: 'navigation', keys: ['shift+tab'] },
  { id: 'nav.search', label: 'Search', group: 'navigation', keys: ['/'] },
  { id: 'nav.senderCard', label: 'Toggle sender card', group: 'navigation', keys: ['i'] },
  { id: 'go.inbox', label: 'Go to Inbox', group: 'navigation', keys: ['g i'] },
  { id: 'go.done', label: 'Go to Done', group: 'navigation', keys: ['g e'] },
  { id: 'go.sent', label: 'Go to Sent', group: 'navigation', keys: ['g s'] },
  { id: 'go.drafts', label: 'Go to Drafts', group: 'navigation', keys: ['g d'] },
  { id: 'go.reminders', label: 'Go to Reminders', group: 'navigation', keys: ['g h'] },
  { id: 'go.followUps', label: 'Go to Follow-ups', group: 'navigation', keys: ['g f'] },
  { id: 'go.starred', label: 'Go to Starred', group: 'navigation', keys: ['g *'] },
  { id: 'go.trash', label: 'Go to Trash', group: 'navigation', keys: ['g t'] },
  { id: 'go.spam', label: 'Go to Spam', group: 'navigation', keys: ['g !'] },
  { id: 'scope.all', label: 'All accounts', group: 'navigation', keys: ['mod+0'] },
  // Triage
  { id: 'thread.done', label: 'Mark done', group: 'triage', keys: ['e'] },
  { id: 'thread.undone', label: 'Move to inbox', group: 'triage', keys: ['shift+e'] },
  { id: 'thread.snooze', label: 'Remind me', group: 'triage', keys: ['h'] },
  { id: 'thread.trash', label: 'Trash', group: 'triage', keys: ['#'] },
  { id: 'thread.star', label: 'Star', group: 'triage', keys: ['s'] },
  { id: 'thread.toggleRead', label: 'Mark read / unread', group: 'triage', keys: ['u'] },
  { id: 'thread.move', label: 'Move to…', group: 'triage', keys: ['v'] },
  { id: 'thread.label', label: 'Label…', group: 'triage', keys: ['l'] },
  { id: 'thread.mute', label: 'Mute thread', group: 'triage', keys: ['m'] },
  { id: 'thread.unsubscribe', label: 'Unsubscribe', group: 'triage', keys: ['mod+u'] },
  { id: 'thread.spam', label: 'Mark as spam', group: 'triage', keys: ['!'] },
  { id: 'thread.block', label: 'Block sender', group: 'triage', keys: [] },
  // Compose
  { id: 'compose.new', label: 'Compose', group: 'compose', keys: ['c'] },
  { id: 'compose.reply', label: 'Reply', group: 'compose', keys: ['r'] },
  { id: 'compose.replyAll', label: 'Reply all', group: 'compose', keys: ['a'] },
  { id: 'compose.forward', label: 'Forward', group: 'compose', keys: ['f'] },
  { id: 'compose.send', label: 'Send', group: 'compose', keys: ['mod+enter'] },
  {
    id: 'compose.remind',
    label: 'Remind me if no reply',
    group: 'compose',
    keys: ['mod+shift+r'],
  },
  { id: 'compose.snippets', label: 'Insert snippet', group: 'compose', keys: ['mod+;'] },
  { id: 'compose.instantIntro', label: 'Instant intro', group: 'compose', keys: ['mod+shift+i'] },
  { id: 'nudge.dismiss', label: 'Dismiss follow-up', group: 'triage', keys: [] },
  { id: 'app.snippets', label: 'Edit snippets', group: 'app', keys: [] },
  {
    id: 'compose.global',
    label: 'Compose from anywhere',
    group: 'compose',
    keys: ['mod+ctrl+m'],
    platforms: ['macos'],
  },
  // Selection
  { id: 'select.toggle', label: 'Select', group: 'selection', keys: ['x'] },
  {
    id: 'select.extendDown',
    label: 'Extend selection down',
    group: 'selection',
    keys: ['shift+j'],
  },
  { id: 'select.extendUp', label: 'Extend selection up', group: 'selection', keys: ['shift+k'] },
  { id: 'select.all', label: 'Select all', group: 'selection', keys: ['mod+a'] },
  { id: 'undo', label: 'Undo', group: 'selection', keys: ['z'] },
  // App
  { id: 'app.palette', label: 'Command palette', group: 'app', keys: ['mod+k'] },
  { id: 'app.shortcuts', label: 'Keyboard shortcuts', group: 'app', keys: ['?'] },
  { id: 'app.settings', label: 'Settings', group: 'app', keys: ['mod+,'] },
  { id: 'app.splitRules', label: 'Edit splits and rules', group: 'app', keys: [] },
  { id: 'app.notifications', label: 'Notification settings', group: 'app', keys: [] },
  { id: 'app.toggleSidebar', label: 'Toggle sidebar', group: 'app', keys: ['mod+\\'] },
] as const satisfies readonly KeyBinding[]

export type CommandId = (typeof keymap)[number]['id']

/** Minimal shape of a DOM KeyboardEvent so this stays platform-neutral. */
export interface KeyEventLike {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

// Keys whose printed character already implies Shift; Shift is not part of their chord.
const SHIFTED_SYMBOLS = new Set([
  '#',
  '!',
  '?',
  '*',
  '@',
  '$',
  '%',
  '^',
  '&',
  '(',
  ')',
  '_',
  '+',
  ':',
  '"',
  '<',
  '>',
  '|',
  '~',
  '{',
  '}',
])

/** Normalises an event into the chord syntax used by the keymap ("mod+k", "shift+e", "#"). */
export function chordFromEvent(e: KeyEventLike, isApple: boolean): string {
  const key = e.key.toLowerCase()
  const mods: string[] = []
  if (isApple ? e.metaKey : e.ctrlKey) mods.push('mod')
  if (isApple && e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey && !SHIFTED_SYMBOLS.has(key)) mods.push('shift')
  return [...mods, key].join('+')
}

/**
 * Stateful matcher for single chords and multi-step sequences. Built once from the keymap
 * into a trie, so each keypress is an O(1) lookup (the < 16 ms budget starts here).
 */
export class KeySequenceMatcher<Id extends string = CommandId> {
  private root = new Map<string, Node<Id>>()
  private pending: Map<string, Node<Id>> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    bindings: readonly { id: Id; keys: readonly string[] }[],
    private sequenceTimeoutMs = 1200,
  ) {
    for (const b of bindings) {
      for (const k of b.keys) {
        let level = this.root
        const steps = k.split(' ')
        steps.forEach((step, i) => {
          let node = level.get(step)
          if (!node) level.set(step, (node = { children: new Map() }))
          if (i === steps.length - 1) node.id = b.id
          level = node.children
        })
      }
    }
  }

  /** Feed one chord. Returns the command id when a binding completes, else null. */
  press(chord: string): Id | null {
    const level = this.pending ?? this.root
    const node = level.get(chord)
    this.clear()
    if (!node) {
      // A broken sequence restarts from this key, so "g x j" still moves down.
      if (level !== this.root) return this.press(chord)
      return null
    }
    if (node.children.size > 0) {
      this.pending = node.children
      this.timer = setTimeout(() => this.clear(), this.sequenceTimeoutMs)
      return null
    }
    return node.id ?? null
  }

  get isPending(): boolean {
    return this.pending !== null
  }

  clear(): void {
    this.pending = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

interface Node<Id> {
  id?: Id
  children: Map<string, Node<Id>>
}

/** Display form of a key string for kbd hints: "mod+k" → "⌘K" on Apple, "Ctrl+K" elsewhere. */
export function formatKeys(keys: string, isApple: boolean): string {
  const names: Record<string, string> = isApple
    ? { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩', escape: 'Esc', tab: 'Tab' }
    : {
        mod: 'Ctrl+',
        shift: 'Shift+',
        alt: 'Alt+',
        ctrl: 'Ctrl+',
        enter: 'Enter',
        escape: 'Esc',
        tab: 'Tab',
      }
  return keys
    .split(' ')
    .map((step) =>
      step
        .split('+')
        .map((p) => names[p] ?? p.toUpperCase())
        .join(''),
    )
    .join(' then ')
}
