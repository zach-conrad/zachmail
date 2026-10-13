import { keymap } from '@zachmail/core'
import { describe, expect, it } from 'vitest'
import { buildMenuSpec, toAccelerator } from './menu'

describe('toAccelerator', () => {
  it('converts mod chords', () => {
    expect(toAccelerator('mod+k')).toBe('CmdOrCtrl+K')
    expect(toAccelerator('mod+,')).toBe('CmdOrCtrl+Comma')
    expect(toAccelerator('mod+\\')).toBe('CmdOrCtrl+Backslash')
    expect(toAccelerator('mod+ctrl+m')).toBe('CmdOrCtrl+Control+M')
    expect(toAccelerator('mod+shift+e')).toBe('CmdOrCtrl+Shift+E')
  })

  it('leaves single keys, sequences and Edit-menu chords to the web view', () => {
    expect(toAccelerator('e')).toBeUndefined()
    expect(toAccelerator('shift+e')).toBeUndefined()
    expect(toAccelerator('g i')).toBeUndefined()
    expect(toAccelerator('mod+a')).toBeUndefined()
  })
})

describe('menu spec', () => {
  const spec = buildMenuSpec()

  it('puts every macOS command in exactly one place', () => {
    const placed = [...spec.app, ...spec.menus.flatMap((m) => m.items), ...spec.help].flatMap(
      (i) => ('id' in i ? [i.id] : []),
    )
    const global = keymap.filter((b) => b.id === 'compose.global').length
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.length + global).toBe(keymap.length)
  })

  it('registers the global compose shortcut', () => {
    expect(spec.global).toEqual([{ accelerator: 'CmdOrCtrl+Control+M', command: 'compose.new' }])
  })

  it('matches the menu the shell embeds (run `pnpm --filter @zachmail/desktop menu`)', async () => {
    await expect(JSON.stringify(spec, null, 2) + '\n').toMatchFileSnapshot('../src-tauri/menu.json')
  })
})
