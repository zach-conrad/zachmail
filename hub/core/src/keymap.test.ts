import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeySequenceMatcher, chordFromEvent, formatKeys, keyConflicts, keymap } from './keymap'

const ev = (key: string, m: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {}) => ({
  key,
  metaKey: !!m.meta,
  ctrlKey: !!m.ctrl,
  altKey: !!m.alt,
  shiftKey: !!m.shift,
})

describe('keymap registry', () => {
  it('has unique ids and no conflicting keys', () => {
    const ids = keymap.map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(keyConflicts(keymap)).toEqual([])
  })

  it('reports keys that would fire together', () => {
    const b = (id: string, keys: string[], module?: 'mail' | 'tasks') => ({
      id,
      label: id,
      group: 'app' as const,
      keys,
      ...(module ? { module } : {}),
    })
    expect(keyConflicts([b('a', ['c'], 'mail'), b('b', ['c'], 'tasks')])).toEqual([])
    expect(keyConflicts([b('a', ['c']), b('b', ['c'], 'tasks')])).toHaveLength(1)
    expect(keyConflicts([b('a', ['c'], 'mail'), b('b', ['c'], 'mail')])).toHaveLength(1)
    expect(keyConflicts([b('a', ['g']), b('b', ['g i'])])).toHaveLength(1)
  })

  it('binds the hub module keys globally (design H2)', () => {
    const m = new KeySequenceMatcher(keymap)
    for (const [k, id] of [
      ['h', 'go.today'],
      ['m', 'go.mail'],
      ['t', 'go.tasks'],
      ['d', 'go.docs'],
    ] as const) {
      m.press('g')
      expect(m.press(k)).toBe(id)
    }
    expect(m.pressAll('c')).toEqual(['compose.new', 'tasks.new'])
  })
})

describe('chordFromEvent', () => {
  it('maps the platform modifier to mod', () => {
    expect(chordFromEvent(ev('k', { meta: true }), true)).toBe('mod+k')
    expect(chordFromEvent(ev('k', { ctrl: true }), false)).toBe('mod+k')
  })
  it('keeps shift for letters but not for shifted symbols', () => {
    expect(chordFromEvent(ev('E', { shift: true }), true)).toBe('shift+e')
    expect(chordFromEvent(ev('#', { shift: true }), true)).toBe('#')
  })
})

describe('KeySequenceMatcher', () => {
  afterEach(() => vi.useRealTimers())

  it('matches single chords and sequences', () => {
    const m = new KeySequenceMatcher(keymap)
    expect(m.press('j')).toBe('nav.next')
    expect(m.press('g')).toBeNull()
    expect(m.isPending).toBe(true)
    expect(m.press('i')).toBe('go.inbox')
    expect(m.press('mod+k')).toBe('app.palette')
  })

  it('restarts from the current key when a sequence breaks', () => {
    const m = new KeySequenceMatcher(keymap)
    m.press('g')
    expect(m.press('j')).toBe('nav.next')
  })

  it('drops a pending sequence after the timeout', () => {
    vi.useFakeTimers()
    const m = new KeySequenceMatcher(keymap, 100)
    m.press('g')
    vi.advanceTimersByTime(150)
    expect(m.press('i')).toBe('nav.senderCard')
  })
})

describe('formatKeys', () => {
  it('renders platform glyphs', () => {
    expect(formatKeys('mod+k', true)).toBe('⌘K')
    expect(formatKeys('mod+k', false)).toBe('Ctrl+K')
    expect(formatKeys('g i', true)).toBe('G then I')
  })
})
