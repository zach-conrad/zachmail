import { useLayoutEffect } from 'react'
import { endInteraction } from '../lib/perf'

/** Tasks module route. The tasks + reminders build (ZACHHUB_PLAN.md §3.2) fills this in. */
export function TasksModule() {
  useLayoutEffect(() => endInteraction('go.tasks'), [])
  return (
    <main className="module-empty" aria-label="Tasks">
      <h1 className="display">Tasks</h1>
      <p className="muted">Tasks and reminders land here next.</p>
    </main>
  )
}
