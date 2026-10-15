import { keymap, type CommandId } from '@zachhub/core'

const KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
}

/**
 * Keyboard events that trigger `id` through the web app's key handler, one per sequence step.
 * Used when the web app doesn't handle a `zachmail:command` event itself, so every command it
 * binds keys for works from the menu bar without extra code. Empty for unbound commands.
 */
export function keyEventsFor(id: CommandId): KeyboardEventInit[] {
  const binding = keymap.find((b) => b.id === id)
  const keys = binding?.keys[0]
  if (!keys) return []
  return keys.split(' ').map((step) => {
    const parts = step.split('+')
    // A lone "+" key would split into empty strings; no binding uses it today.
    const key = parts.pop()!
    const shift = parts.includes('shift')
    return {
      key: KEYS[key] ?? (shift && key.length === 1 ? key.toUpperCase() : key),
      metaKey: parts.includes('mod'),
      ctrlKey: parts.includes('ctrl'),
      altKey: parts.includes('alt'),
      shiftKey: shift,
      bubbles: true,
      cancelable: true,
    }
  })
}
