import { KeySequenceMatcher, chordFromEvent, keymap, type CommandId } from '@zachhub/core'
import { useLayoutEffect, useRef } from 'react'
import { beginInteraction } from './perf'
import { isApple, isTypingTarget } from './platform'

export type CommandHandlers = Partial<Record<CommandId, () => void>>

// Every mounted useCommands, oldest first. A command runs in the newest scope that handles
// it, so a dialog mounted on top (the palette) wins over the inbox beneath it.
const scopes: { current: CommandHandlers }[] = []
const listeners = new Set<() => void>()

function handlerFor(id: CommandId) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const h = scopes[i]!.current[id]
    if (h) return h
  }
  return undefined
}

/** Whether something on screen handles `id` right now (the palette lists only these). */
export const canRun = (id: CommandId) => !!handlerFor(id)

/** Runs a command by id, as its key binding would. Returns false when nothing handles it. */
export function runCommand(id: CommandId, t0 = performance.now()): boolean {
  const handler = handlerFor(id)
  if (!handler) return false
  beginInteraction(id, t0)
  handler()
  return true
}

/** Notified whenever the set of handled commands may have changed. */
export function subscribeCommands(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const changed = () => listeners.forEach((fn) => fn())

// One global key handler backed by the shared keymap. Handlers run synchronously inside the
// keydown event, so the UI can update in the same frame.
const matcher = new KeySequenceMatcher(keymap)
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.defaultPrevented) return
  const chord = chordFromEvent(e, isApple)
  const hasMod = chord.includes('mod+')
  if (isTypingTarget(e.target) && !hasMod && e.key !== 'Escape') return
  const id = matcher.press(chord)
  if ((id && runCommand(id, e.timeStamp)) || matcher.isPending) e.preventDefault()
}

// The macOS menu bar dispatches commands by id; handling them here skips the key replay.
function onShellCommand(e: CustomEvent<{ id: CommandId }>) {
  if (runCommand(e.detail.id)) e.preventDefault()
}

export function useCommands(handlers: CommandHandlers) {
  const scope = useRef(handlers)
  const ids = Object.keys(handlers).sort().join(' ')
  useLayoutEffect(() => {
    scope.current = handlers
  })
  useLayoutEffect(() => {
    if (!scopes.length) {
      window.addEventListener('keydown', onKey)
      window.addEventListener('zachmail:command', onShellCommand as EventListener)
    }
    scopes.push(scope)
    return () => {
      scopes.splice(scopes.indexOf(scope), 1)
      if (!scopes.length) {
        window.removeEventListener('keydown', onKey)
        window.removeEventListener('zachmail:command', onShellCommand as EventListener)
        matcher.clear()
      }
      changed()
    }
  }, [])
  // Handler identities change every render; only the set of ids matters to listeners.
  useLayoutEffect(changed, [ids])
}
