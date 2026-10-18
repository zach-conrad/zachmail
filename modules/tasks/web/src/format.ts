import { addDays, daysBetween, fromDateKey, LIST_COLORS, type Clock } from '@zachhub/tasks-core'
import { tokens } from '@zachhub/tokens'

export function listColor(color: string): string {
  const i = (LIST_COLORS as readonly string[]).indexOf(color)
  return tokens.account[i < 0 ? tokens.account.length - 1 : i]!
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const clockTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function formatTime(time: string): string {
  return clockTime.format(fromDateKey('2000-01-01', time))
}

/** "Today", "Tomorrow", "Yesterday", "Sat" (this week), "Oct 20", "Jan 4, 2028". */
export function formatDay(date: string, clock: Clock): string {
  const diff = daysBetween(clock.today, date)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  const d = fromDateKey(date)
  if (diff > 1 && diff < 7) return weekday.format(d)
  return date.slice(0, 4) === clock.today.slice(0, 4) ? monthDay.format(d) : monthDayYear.format(d)
}

export function formatDue(date: string | null, time: string | null, clock: Clock): string {
  if (!date) return ''
  return time ? `${formatDay(date, clock)} ${formatTime(time)}` : formatDay(date, clock)
}

/** For the completion toast: "next on Sat", "next on Nov 1". */
export const formatNext = (date: string, clock: Clock) => {
  const day = formatDay(date, clock)
  return day === 'Today' || day === 'Tomorrow' ? `next due ${day.toLowerCase()}` : `next on ${day}`
}

export function formatAlert(at: number, clock: Clock): string {
  const d = new Date(at)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${formatDay(key, clock)} ${clockTime.format(d)}`
}

export const tomorrowOf = (clock: Clock) => addDays(clock.today, 1)
