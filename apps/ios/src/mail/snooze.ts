/** Snooze presets from design §3.6, resolved against the local clock. */

export interface SnoozeOption {
  id: string
  label: string
  /** Epoch ms; null for Someday (no automatic return). */
  until: number | null
}

const at = (base: Date, dayOffset: number, hour: number): number => {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

export function snoozeOptions(now: number): SnoozeOption[] {
  const d = new Date(now)
  const day = d.getDay() // 0 Sun … 6 Sat
  const tonight = at(d, 0, 20)
  const toSaturday = (6 - day + 7) % 7 || 7
  const toMonday = (1 - day + 7) % 7 || 7
  return [
    { id: 'later', label: 'Later today', until: now + 3 * 3_600_000 },
    { id: 'tonight', label: 'Tonight', until: tonight > now ? tonight : at(d, 1, 20) },
    { id: 'tomorrow', label: 'Tomorrow', until: at(d, 1, 8) },
    { id: 'weekend', label: 'This weekend', until: at(d, day === 6 ? 7 : toSaturday, 9) },
    { id: 'nextWeek', label: 'Next week', until: at(d, toMonday, 8) },
    { id: 'someday', label: 'Someday', until: null },
  ]
}
