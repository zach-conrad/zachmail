/** Floating local dates ("YYYY-MM-DD") and times ("HH:MM"). */

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

export const dateKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const timeKey = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Local midnight of a date key (or the given time on it). */
export function fromDateKey(key: string, time?: string | null): Date {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const [hh, mm] = time ? (time.split(':').map(Number) as [number, number]) : [0, 0]
  return new Date(y, m - 1, d, hh, mm)
}

export function addDays(key: string, days: number): string {
  const d = fromDateKey(key)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((fromDateKey(b).getTime() - fromDateKey(a).getTime()) / 86_400_000)
}

/** "now" as the two keys smart lists compare against. */
export interface Clock {
  today: string
  time: string
}

export const clockAt = (now: Date): Clock => ({ today: dateKey(now), time: timeKey(now) })
