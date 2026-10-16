import { chordFromEvent, KeySequenceMatcher } from '@zachhub/core'
import { tasksKeymap, type TaskCommandId } from '@zachhub/tasks-core'
import { useLayoutEffect, useRef } from 'react'
import { beginInteraction } from './perf'

export type TaskHandlers = Partial<Record<TaskCommandId, () => void>>

export const isApple =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return (
    t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT'
  )
}

/**
 * The Tasks screen's key handler, built from `tasksKeymap`. Handlers run synchronously in the
 * keydown, so the row updates in the same frame. Mail's handler isn't mounted on this screen,
 * so the shared verbs (E, H, #, Z…) don't collide.
 */
export function useTaskKeys(handlers: TaskHandlers) {
  const ref = useRef(handlers)
  useLayoutEffect(() => {
    ref.current = handlers
  })
  useLayoutEffect(() => {
    const matcher = new KeySequenceMatcher<TaskCommandId>(tasksKeymap)
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.defaultPrevented) return
      const chord = chordFromEvent(e, isApple)
      if (isTypingTarget(e.target) && !chord.includes('mod+') && e.key !== 'Escape') return
      const id = matcher.press(chord)
      const handler = id ? ref.current[id] : undefined
      if (handler) {
        e.preventDefault()
        beginInteraction(id!, e.timeStamp)
        handler()
      } else if (matcher.isPending) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      matcher.clear()
    }
  }, [])
}
