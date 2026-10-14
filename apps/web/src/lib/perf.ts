// Client timing marks for the speed budgets (architecture §1a). The Playwright perf harness
// reads `window.__zmPerf`; production telemetry can ship the same samples later.

interface Pending {
  name: string
  t0: number
}

const samples: Record<string, number[]> = {}
const marks: Record<string, number> = {}
let pending: Pending | null = null

declare global {
  interface Window {
    __zmPerf?: { samples: typeof samples; marks: typeof marks }
  }
}
window.__zmPerf = { samples, marks }

/** Start timing an interaction at its input event's timestamp. */
export function beginInteraction(name: string, t0 = performance.now()) {
  pending = { name, t0 }
}

/** The UI for `name` has committed; record input → commit if that interaction is pending. */
export function endInteraction(name: string) {
  if (pending?.name !== name) return
  ;(samples[name] ??= []).push(performance.now() - pending.t0)
  pending = null
}

/** One-off milestone measured from navigation start (cold start). */
export function markOnce(name: string) {
  if (marks[name] === undefined) marks[name] = performance.now()
}
