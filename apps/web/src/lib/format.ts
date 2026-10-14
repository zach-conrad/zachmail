import type { Address } from '@zachmail/core'

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})
const long = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})

const HOUR = 3_600_000

/** List timestamp per design §6.1: "9m", "2h", "Mon", "Oct 3", "Oct 3, 2024". */
export function shortTime(ts: number, now = Date.now()): string {
  const d = now - ts
  if (d < 60_000) return 'now'
  if (d < HOUR) return `${Math.floor(d / 60_000)}m`
  if (d < 24 * HOUR) return `${Math.floor(d / HOUR)}h`
  if (d < 6 * 24 * HOUR) return weekday.format(ts)
  return new Date(ts).getFullYear() === new Date(now).getFullYear()
    ? monthDay.format(ts)
    : fullDate.format(ts)
}

export const longTime = (ts: number) => long.format(ts)

const dayStart = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)

/** When a snooze or reminder is due: "Today 3:00 PM", "Tomorrow 8:00 AM", "Sat 9:00 AM". */
export function dueTime(ts: number, now = Date.now()): string {
  const days = Math.round((dayStart(ts) - dayStart(now)) / (24 * HOUR))
  const at = time.format(ts)
  if (days === 0) return `Today ${at}`
  if (days === 1) return `Tomorrow ${at}`
  if (days > 1 && days < 7) return `${weekday.format(ts)} ${at}`
  const date =
    new Date(ts).getFullYear() === new Date(now).getFullYear()
      ? monthDay.format(ts)
      : fullDate.format(ts)
  return `${date}, ${at}`
}
export const clockTime = (ts: number) => time.format(ts)

export const displayName = (a: Address) => a.name?.trim() || a.email

/** Row sender label: other participants (first names when several), or "me". */
export function senderLabel(participants: readonly Address[], own: ReadonlySet<string>): string {
  const others = participants.filter((p) => !own.has(p.email.toLowerCase()))
  if (!others.length) return 'me'
  if (others.length === 1) return displayName(others[0]!)
  return others
    .slice(0, 3)
    .map((p) => displayName(p).split(/[\s@]/)[0])
    .join(', ')
}
