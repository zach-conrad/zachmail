/**
 * Snooze picker times (design §3.6), shared by every client so "Tomorrow" means the same thing
 * on web, macOS and iOS. Pure and local-time: it runs in the click path, so no network and no
 * date library.
 */

export type SnoozePresetId = 'later' | 'tonight' | 'tomorrow' | 'weekend' | 'nextWeek' | 'someday'

export interface SnoozeOption {
  id: SnoozePresetId
  label: string
  /** Epoch ms. */
  at: number
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]
/** Default hour when a day is named without a time. */
const MORNING = 8

function at(base: Date, days: number, hour: number, minute = 0): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  d.setHours(hour, minute, 0, 0)
  return d
}

/** Days from `now` to the next `weekday` (0 = Sunday), 1-7: never today. */
const daysUntil = (now: Date, weekday: number) => ((weekday - now.getDay() + 6) % 7) + 1

/**
 * The picker's presets, in display order. "Tonight" is left out once it is less than an hour
 * away, and "This weekend" becomes next weekend once the weekend has started.
 */
export function snoozeOptions(now: Date = new Date()): SnoozeOption[] {
  const later = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  later.setSeconds(0, 0)
  const tonight = at(now, 0, 20)
  const day = now.getDay()
  const weekendDays = day === 6 && now.getHours() < 9 ? 0 : daysUntil(now, 6)
  const options: SnoozeOption[] = [
    { id: 'later', label: 'Later today', at: later.getTime() },
    { id: 'tonight', label: 'Tonight', at: tonight.getTime() },
    { id: 'tomorrow', label: 'Tomorrow', at: at(now, 1, MORNING).getTime() },
    { id: 'weekend', label: 'This weekend', at: at(now, weekendDays, 9).getTime() },
    { id: 'nextWeek', label: 'Next week', at: at(now, daysUntil(now, 1), MORNING).getTime() },
    { id: 'someday', label: 'Someday', at: someday(now).getTime() },
  ]
  return options.filter((o) => o.id !== 'tonight' || o.at - now.getTime() >= 60 * 60 * 1000)
}

/** Three months out, in the morning. */
function someday(now: Date): Date {
  const d = at(now, 0, MORNING)
  d.setMonth(d.getMonth() + 3)
  return d
}

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
}

const dayIndex = (word: string) =>
  word.length >= 3 ? DAY_NAMES.findIndex((d) => d.startsWith(word)) : -1
const monthIndex = (word: string) =>
  word.length >= 3 ? MONTH_NAMES.findIndex((m) => m.startsWith(word)) : -1

/** "8am", "8:30 pm", "14:00", "noon", "midnight" → [hour, minute]. */
function parseTime(text: string): { time: [number, number]; rest: string } | null {
  const named = text.match(/\b(?:at\s+)?(noon|midnight)\b/)
  if (named)
    return {
      time: named[1] === 'noon' ? [12, 0] : [0, 0],
      rest: text.replace(named[0], ' '),
    }
  // A bare number is only a time with ":mm" or am/pm, so the 20 in "oct 20 2pm" stays a date.
  const m = [...text.matchAll(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?\b/g)].find(
    (x) => x[2] || x[3],
  )
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const meridiem = m[3]?.[0]
  if (minute > 59 || hour > (meridiem ? 12 : 23)) return null
  if (meridiem === 'p' && hour < 12) hour += 12
  if (meridiem === 'a' && hour === 12) hour = 0
  return { time: [hour, minute], rest: text.replace(m[0], ' ') }
}

/**
 * Parses the picker's free-text box: "in 3 days", "in 2 hours", "tomorrow 8am", "fri",
 * "next week", "weekend", "oct 20 2pm", "10/20", "3pm". Returns epoch ms, or null when the
 * text isn't understood or lands in the past.
 */
export function parseSnoozeTime(input: string, now: Date = new Date()): number | null {
  const text = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
  if (!text) return null

  const rel = text.match(/^in\s+(an?|\d+)\s*([a-z]+)$/)
  if (rel) {
    const n = rel[1]!.startsWith('a') ? 1 : Number(rel[1])
    const unit = rel[2]!
    if (UNIT_MS[unit]) return now.getTime() + n * UNIT_MS[unit]
    const d = new Date(now)
    if (/^(d|days?)$/.test(unit)) d.setDate(d.getDate() + n)
    else if (/^(w|wks?|weeks?)$/.test(unit)) d.setDate(d.getDate() + 7 * n)
    else if (/^(mo|mos|months?)$/.test(unit)) d.setMonth(d.getMonth() + n)
    else return null
    return d.getTime()
  }

  const preset = snoozeOptions(now).find(
    (o) => o.label.toLowerCase() === text || o.id.toLowerCase() === text,
  )
  if (preset) return preset.at

  const parsedTime = parseTime(text)
  const rest = (parsedTime?.rest ?? text).trim().replace(/\s+/g, ' ')
  const time = parsedTime?.time

  let date: Date | null
  let defaultHour = MORNING
  if (!rest || rest === 'today') {
    if (!time) return null
    date = at(now, 0, 0)
    // A bare time that has passed today means tomorrow; "today 9am" at 10 is just past.
    if (!rest && at(now, 0, time[0], time[1]) <= now) date = at(now, 1, 0)
  } else if (rest === 'tonight') {
    date = at(now, 0, 0)
    defaultHour = 20
  } else if (rest === 'tomorrow' || rest === 'tmrw' || rest === 'tmr') {
    date = at(now, 1, 0)
  } else if (rest === 'next week') {
    date = at(now, daysUntil(now, 1), 0)
  } else if (rest === 'weekend' || rest === 'this weekend') {
    date = at(now, now.getDay() === 6 ? 0 : daysUntil(now, 6), 0)
    defaultHour = 9
  } else {
    const words = rest.replace(/^(next|on|this)\s+/, '').split(' ')
    const wd = words.length === 1 ? dayIndex(words[0]!) : -1
    if (wd >= 0) {
      date = at(now, daysUntil(now, wd), 0)
    } else {
      date = parseCalendarDate(words, now)
    }
  }
  if (!date) return null
  const [hour, minute] = time ?? [defaultHour, 0]
  date.setHours(hour, minute, 0, 0)
  return date.getTime() > now.getTime() ? date.getTime() : null
}

/** "oct 20", "20 oct", "october 20th", "10/20", "10/20/2027": the next such date. */
function parseCalendarDate(words: string[], now: Date): Date | null {
  let month: number
  let day: number
  let year: number | null = null
  if (words.length === 1) {
    const m = words[0]!.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
    if (!m) return null
    month = Number(m[1]) - 1
    day = Number(m[2])
    if (m[3]) year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
  } else if (words.length === 2 || words.length === 3) {
    const num = (w: string) => w.match(/^(\d{1,2})(st|nd|rd|th)?$/)?.[1]
    const [a, b, c] = words as [string, string, string | undefined]
    if (monthIndex(a) >= 0 && num(b)) {
      month = monthIndex(a)
      day = Number(num(b))
    } else if (num(a) && monthIndex(b) >= 0) {
      month = monthIndex(b)
      day = Number(num(a))
    } else return null
    if (c !== undefined) {
      if (!/^\d{4}$/.test(c)) return null
      year = Number(c)
    }
  } else return null
  if (month < 0 || month > 11 || day < 1 || day > 31) return null
  const d = new Date(year ?? now.getFullYear(), month, day)
  if (d.getMonth() !== month) return null
  // Without a year, a date already past this year means next year.
  if (year === null && at(d, 0, 23, 59) < now) d.setFullYear(d.getFullYear() + 1)
  return d
}
