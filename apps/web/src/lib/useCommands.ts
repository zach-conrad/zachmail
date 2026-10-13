import { KeySequenceMatcher, chordFromEvent, keymap, type CommandId } from '@zachmail/core'
import { useEffect, useEffectEvent } from 'react'
import { isApple, isTypingTarget } from './platform'

export type CommandHandlers = Partial<Record<CommandId, () => void>>

/**
 * Global key handler backed by the shared keymap. Handlers run synchronously inside the
 * keydown event, so the UI can update in the same frame.
 */
export function useCommands(handlers: CommandHandlers) {
  const dispatch = useEffectEvent((id: CommandId) => {
    const handler = handlers[id]
    handler?.()
    return !!handler
  })

  useEffect(() => {
    const matcher = new KeySequenceMatcher(keymap)
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const chord = chordFromEvent(e, isApple)
      const hasMod = chord.includes('mod+')
      if (isTypingTarget(e.target) && !hasMod && e.key !== 'Escape') return
      const id = matcher.press(chord)
      if (id && dispatch(id)) {
        e.preventDefault()
      } else if (matcher.isPending) {
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      matcher.clear()
    }
  }, [])
}
