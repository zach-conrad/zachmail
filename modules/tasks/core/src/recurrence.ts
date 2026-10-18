/**
 * Recurrence: RFC 5545 RRULE bodies evaluated with `rrule`. Tasks use floating dates, so rule
 * math runs on UTC dates whose wall-clock fields are the local date and time (the approach the
 * rrule docs recommend), and results convert straight back to date keys.
 */
import { RRule } from 'rrule'
import { dateKey } from './dates'

const floating = (key: string, time: string | null = null) => {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const [hh, mm] = time ? (time.split(':').map(Number) as [number, number]) : [0, 0]
  return new Date(Date.UTC(y, m - 1, d, hh, mm))
}
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
const floatingKey = (d: Date) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** Parses "FREQ=…;…" into its parts (upper-cased keys). */
export function rruleParts(rrule: string): Map<string, string> {
  const parts = new Map<string, string>()
  for (const p of rrule.replace(/^RRULE:/i, '').split(';')) {
    const i = p.indexOf('=')
    if (i > 0) parts.set(p.slice(0, i).toUpperCase(), p.slice(i + 1).toUpperCase())
  }
  return parts
}

function ruleFrom(rrule: string, start: Date): RRule | null {
  try {
    const options = RRule.parseString(rrule.replace(/^RRULE:/i, ''))
    if (options.freq === undefined) return null
    return new RRule({ ...options, dtstart: start })
  } catch {
    return null
  }
}

export const isValidRRule = (rrule: string) => ruleFrom(rrule, new Date(0)) !== null

/**
 * The first occurrence of a new recurring task: today if the rule matches today (and its time,
 * if any, is still ahead of `now`), else the next match. Returns a date key or null.
 */
export function firstOccurrence(rrule: string, now: Date, time: string | null): string | null {
  const today = dateKey(now)
  const start = floating(today, time)
  // The interval counts from the first instance, so "every other Wednesday" starts on the next
  // Wednesday, not the one after: find the first match ignoring INTERVAL.
  const parts = rruleParts(rrule)
  parts.delete('INTERVAL')
  const rule = ruleFrom([...parts].map(([k, v]) => `${k}=${v}`).join(';'), start)
  if (!rule) return null
  const nowFloating = floating(today, `${pad(now.getHours())}:${pad(now.getMinutes())}`)
  let first = rule.after(start, true)
  if (first && time && first.getTime() <= nowFloating.getTime()) first = rule.after(first, false)
  return first ? floatingKey(first) : null
}

export interface NextInstance {
  dueDate: string
  /** The rule for the next instance: COUNT counts down so the series still ends on time. */
  rrule: string | null
}

/**
 * When a recurring task is completed: the next due date after its current one, skipping any
 * occurrences already in the past (a rent reminder ticked off two months late should not leave a
 * backlog of overdue copies). With no due date the series restarts from `today`. Null when the
 * series has ended (UNTIL passed or COUNT used up).
 */
export function nextInstance(
  rrule: string,
  dueDate: string | null,
  dueTime: string | null,
  today: string,
): NextInstance | null {
  const parts = rruleParts(rrule)
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : null
  if (count !== null && count <= 1) return null
  const start = floating(dueDate ?? today, dueTime)
  const rule = ruleFrom(rrule, start)
  if (!rule) return null
  let next = rule.after(start, false)
  const todayStart = floating(today)
  if (next && next < todayStart) next = rule.after(todayStart, true)
  if (!next) return null
  let nextRule: string | null = rrule
  if (count !== null) {
    parts.set('COUNT', String(count - 1))
    nextRule = [...parts].map(([k, v]) => `${k}=${v}`).join(';')
  }
  return { dueDate: floatingKey(next), rrule: nextRule }
}

const DAY_NAMES: Record<string, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function ordinal(n: number): string {
  if (n === -1) return 'last'
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${s}`
}

function describeDay(token: string): string {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token)
  if (!m) return token
  const name = DAY_NAMES[m[2]!] ?? m[2]!
  return m[1] ? `${ordinal(Number(m[1]))} ${name}` : name
}

/** Short label for chips and rows: "Daily", "Weekdays", "Monthly on the 1st", "Every 2 weeks on Mon". */
export function describeRRule(rrule: string): string {
  const p = rruleParts(rrule)
  const interval = Number(p.get('INTERVAL') ?? '1')
  const byDay = p.get('BYDAY')?.split(',') ?? []
  const byMonthDay = p.get('BYMONTHDAY')
  const every = (unit: string, one: string) => (interval > 1 ? `Every ${interval} ${unit}s` : one)
  switch (p.get('FREQ')) {
    case 'DAILY':
      return every('day', 'Daily')
    case 'WEEKLY': {
      const days = byDay.join(',')
      if (interval === 1 && days === 'MO,TU,WE,TH,FR') return 'Weekdays'
      if (interval === 1 && days === 'SA,SU') return 'Weekends'
      const base = every('week', 'Weekly')
      return byDay.length ? `${base} on ${byDay.map(describeDay).join(', ')}` : base
    }
    case 'MONTHLY': {
      const base = every('month', 'Monthly')
      if (byMonthDay) {
        const n = Number(byMonthDay)
        return `${base} on the ${n === -1 ? 'last day' : ordinal(n)}`
      }
      if (byDay.length) return `${base} on the ${byDay.map(describeDay).join(', ')}`
      return base
    }
    case 'YEARLY': {
      const base = every('year', 'Yearly')
      const month = Number(p.get('BYMONTH') ?? '0')
      if (month && byMonthDay) return `${base} on ${MONTHS[month - 1]} ${byMonthDay}`
      return base
    }
    case 'HOURLY':
      return every('hour', 'Hourly')
    default:
      return 'Repeats'
  }
}
