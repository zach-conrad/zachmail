import { useLayoutEffect } from 'react'
import { endInteraction } from '../lib/perf'

/** Docs module route. The documents build (ZACHHUB_PLAN.md §3.3) fills this in. */
export function DocsModule() {
  useLayoutEffect(() => endInteraction('go.docs'), [])
  return (
    <main className="module-empty" aria-label="Docs">
      <h1 className="display">Docs</h1>
      <p className="muted">Your documents land here next.</p>
    </main>
  )
}
