import { KeySequenceMatcher, chordFromEvent, keymap, type CommandId } from '@zachmail/core'
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
      let hit: string | null = null
      for (const e of events) hit = matcher.press(chordFromEvent(asEvent(e), true))
      expect(hit, b.id).toBe(b.id)
    }
  })
})
