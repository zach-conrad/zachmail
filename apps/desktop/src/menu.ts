import { keymap, type CommandId, type KeyBinding } from '@zachmail/core'

/**
 * The macOS menu bar, generated from the core keymap (design §4: the menu bar mirrors the
 * keymap). The result is written to src-tauri/menu.json, which the Rust shell embeds so the
 * menu exists before the web view loads. `pnpm --filter @zachmail/desktop menu` regenerates
 * it; a test fails if it drifts from the keymap.
 */

export type MenuItemSpec = { id: string; label: string; accelerator?: string } | { separator: true }

export interface MenuSpec {
  /** Inserted into the app menu after "About ZachMail". */
  app: MenuItemSpec[]
  /** Top-level menus between Edit and Window. */
  menus: { title: string; items: MenuItemSpec[] }[]
  help: MenuItemSpec[]
  /** System-wide shortcuts and the command each one runs once the window is focused. */
  global: { accelerator: string; command: CommandId }[]
}

// Chords the Edit menu owns so text fields keep native undo, clipboard and select-all.
const EDIT_CHORDS = new Set(['mod+z', 'mod+shift+z', 'mod+x', 'mod+c', 'mod+v', 'mod+a'])

const MODIFIERS: Record<string, string> = {
  mod: 'CmdOrCtrl',
  ctrl: 'Control',
  shift: 'Shift',
  alt: 'Alt',
}

const KEY_NAMES: Record<string, string> = {
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '\\': 'Backslash',
  ';': 'Semicolon',
  "'": 'Quote',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '-': 'Minus',
  '=': 'Equal',
  '`': 'Backquote',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
}

/**
 * Tauri accelerator for a keymap chord, or undefined when the chord should not be a native
 * key equivalent: single keys and sequences stay with the web key handler, otherwise they
 * would fire while typing in compose.
 */
export function toAccelerator(chord: string): string | undefined {
  if (chord.includes(' ') || !chord.startsWith('mod+') || EDIT_CHORDS.has(chord)) return undefined
  const parts = chord.split('+')
  const key = parts.pop()!
  return [...parts.map((m) => MODIFIERS[m]!), KEY_NAMES[key] ?? key.toUpperCase()].join('+')
}

const onMac = (b: KeyBinding) => !b.platforms || b.platforms.includes('macos')

function item(b: KeyBinding): MenuItemSpec {
  const accelerator = b.keys.map(toAccelerator).find(Boolean)
  return accelerator ? { id: b.id, label: b.label, accelerator } : { id: b.id, label: b.label }
}

const GLOBAL: Partial<Record<CommandId, CommandId>> = { 'compose.global': 'compose.new' }
const APP_MENU = new Set<string>(['app.settings'])
const HELP_MENU = new Set<string>(['app.shortcuts'])

export function buildMenuSpec(bindings: readonly KeyBinding[] = keymap): MenuSpec {
  const mac = bindings.filter(onMac)
  const inGroup = (g: KeyBinding['group']) =>
    mac.filter(
      (b) => b.group === g && !(b.id in GLOBAL) && !APP_MENU.has(b.id) && !HELP_MENU.has(b.id),
    )
  const items = (g: KeyBinding['group']) => inGroup(g).map(item)

  return {
    app: mac.filter((b) => APP_MENU.has(b.id)).map(item),
    menus: [
      { title: 'Go', items: items('navigation') },
      { title: 'Thread', items: [...items('triage'), { separator: true }, ...items('selection')] },
      { title: 'Message', items: items('compose') },
      { title: 'View', items: items('app') },
    ],
    help: mac.filter((b) => HELP_MENU.has(b.id)).map(item),
    global: mac.flatMap((b) => {
      const command = GLOBAL[b.id as CommandId]
      const accelerator = b.keys.map(toAccelerator).find(Boolean)
      return command && accelerator ? [{ accelerator, command }] : []
    }),
  }
}
