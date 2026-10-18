import { KeySequenceMatcher, chordFromEvent, keymap, type CommandId } from '@zachhub/core'
import { describe, expect, it } from 'vitest'
import { keyEventsFor } from './replay'

const asEvent = (e: KeyboardEventInit) => ({
  key: e.key!,
  metaKey: !!e.metaKey,
  ctrlKey: !!e.ctrlKey,
  altKey: !!e.altKey,
  shiftKey: !!e.shiftKey,
})

describe('keyEventsFor', () => {
  it('replays to the same command for every bound key in the keymap', () => {
    const matcher = new KeySequenceMatcher(keymap)
    for (const b of keymap) {
      const events = keyEventsFor(b.id as CommandId)
      if (b.keys.length === 0) {
        expect(events).toEqual([])
        continue
      }
      // Module-scoped bindings can share a key (C is compose in Mail, new task in Tasks); the
      // web handler runs whichever of them is on screen.
      let hits: readonly string[] = []
      for (const e of events) hits = matcher.pressAll(chordFromEvent(asEvent(e), true))
      expect(hits, b.id).toContain(b.id)
    }
  })
})
