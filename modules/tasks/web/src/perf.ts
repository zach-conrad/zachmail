// Interaction timing for the speed budgets, written to the same `window.__zmPerf` the web
// app's perf harness reads (apps/web/src/lib/perf.ts). Input event → UI committed.

interface PerfSink {
  samples: Record<string, number[]>
}

let pending: { name: string; t0: number } | null = null

export function beginInteraction(name: string, t0 = performance.now()) {
  pending = { name, t0 }
}

/** Call from a layout effect: records the pending interaction, if any, as committed now. */
export function endInteraction() {
  if (!pending) return
  const sink = (window as { __zmPerf?: PerfSink }).__zmPerf
  if (sink) (sink.samples[pending.name] ??= []).push(performance.now() - pending.t0)
  pending = null
}
