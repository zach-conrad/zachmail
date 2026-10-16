/**
 * Quick add: one line of natural language → a task, entirely on the client (budget < 16 ms per
 * keystroke, ZACHHUB_PLAN.md §8). A small grammar takes the parts chrono does not know
 * (#list, +tag, !priority, "every …" recurrence, "the 3rd") and chrono-node reads the date and
 * time from what is left. Every recognised span comes back as a token so the field can
 * highlight it inline (design H4).
 *
 *   "pay rent every 1st at 9am #home !" → title "pay rent", monthly on the 1st, 09:00 alert,
 *   list Home, high priority.
 */
import * as chrono from 'chrono-node/en'
import { addDays, dateKey, fromDateKey, timeKey } from './dates'
import { firstOccurrence } from './recurrence'
import type { Priority } from './types'

export type QuickAddTokenKind = 'date' | 'repeat' | 'list' | 'tag' | 'priority'

export interface QuickAddToken {
  kind: QuickAddTokenKind
  /** Offsets into the input, for inline highlighting. */
  start: number
  end: number
  text: string
}

export interface QuickAddResult {
  title: string
  dueDate: string | null
  dueTime: string | null
  alertAt: number | null
  rrule: string | null
  priority: Priority
  /** The matched list, or null when none was typed or the name matched no list. */
  listId: string | null
  /** The name after `#` as typed, so the UI can offer to create a list that doesn't exist. */
  listName: string | null
  tags: string[]
  tokens: QuickAddToken[]
}

export interface QuickAddContext {
  now: Date
  lists: readonly { id: string; name: string }[]
}

/** Default alert time for "remind me to … tomorrow" with no time given. */
export const DEFAULT_ALERT_TIME = '09:00'

const WD =
  'mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?'
const MON =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const ORD = '(\\d{1,2})(?:st|nd|rd|th)'
const NTH = 'first|second|third|fourth|last|1st|2nd|3rd|4th'
const EVERY = '(?:every|each)'
const ANCHOR =
  '(?:of\\s+(?:the|each|every)\\s+month|of\\s+the\\s+month|each\\s+month|every\\s+month)'

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const dayCode = (s: string) => {
  const p = s.slice(0, 2).toLowerCase()
  const i = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'].indexOf(p)
  return DAY_CODES[i]!
}
const MONTH_PREFIXES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]
const monthNumber = (s: string) => MONTH_PREFIXES.indexOf(s.slice(0, 3).toLowerCase()) + 1
const nthNumber = (s: string) =>
  ({ first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, last: -1 })[
    s.toLowerCase()
  ] ?? 1
const intervalOf = (s: string | undefined) =>
  !s ? 1 : /other/i.test(s) ? 2 : Math.max(1, Number.parseInt(s, 10) || 1)
const withInterval = (rule: string, n: number) => (n > 1 ? `${rule};INTERVAL=${n}` : rule)

interface RepeatMatch {
  index: number
  length: number
  rrule: string
  /** Time implied by the phrase ("every morning"). */
  time?: string
}

type RepeatRule = [RegExp, (m: RegExpExecArray) => Omit<RepeatMatch, 'index' | 'length'>]

// Tried in order; the first that matches wins. More specific phrasings come first.
const REPEAT_RULES: RepeatRule[] = [
  [
    new RegExp(`\\b${EVERY}\\s+(other\\s+|\\d+\\s+)?weekdays?\\b`, 'i'),
    (m) => ({ rrule: withInterval('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', intervalOf(m[1])) }),
  ],
  [new RegExp(`\\b${EVERY}\\s+weekends?\\b`, 'i'), () => ({ rrule: 'FREQ=WEEKLY;BYDAY=SA,SU' })],
  [
    new RegExp(`\\b${EVERY}\\s+(morning|evening|night)\\b`, 'i'),
    (m) => ({
      rrule: 'FREQ=DAILY',
      time: { morning: '09:00', evening: '18:00', night: '21:00' }[m[1]!.toLowerCase()]!,
    }),
  ],
  [
    new RegExp(`\\b${EVERY}\\s+(${NTH})\\s+(${WD})\\b(?:\\s+${ANCHOR})?`, 'i'),
    (m) => ({ rrule: `FREQ=MONTHLY;BYDAY=${nthNumber(m[1]!)}${dayCode(m[2]!)}` }),
  ],
  [
    new RegExp(
      `\\b${EVERY}\\s+(other\\s+|\\d+\\s+)?((?:${WD})(?:\\s*(?:,|and|&)?\\s*(?:${WD})\\b)*)s?\\b`,
      'i',
    ),
    (m) => {
      const days = [...m[2]!.matchAll(new RegExp(WD, 'gi'))].map((d) => dayCode(d[0]))
      const unique = DAY_CODES.filter((d) => days.includes(d))
      // Sunday sorts last so "Mon, Sun" reads in week order.
      const ordered = [...unique.filter((d) => d !== 'SU'), ...unique.filter((d) => d === 'SU')]
      return { rrule: withInterval(`FREQ=WEEKLY;BYDAY=${ordered.join(',')}`, intervalOf(m[1])) }
    },
  ],
  [
    new RegExp(
      `\\b${EVERY}\\s+(?:(last\\s+day)|${ORD})(?:\\s+${ANCHOR})?(?!\\s+of\\s+(?:${MON}))\\b`,
      'i',
    ),
    (m) => ({ rrule: `FREQ=MONTHLY;BYMONTHDAY=${m[1] ? -1 : Number(m[2])}` }),
  ],
  [
    new RegExp(`\\b${EVERY}\\s+(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'),
    (m) => ({ rrule: `FREQ=YEARLY;BYMONTH=${monthNumber(m[1]!)};BYMONTHDAY=${Number(m[2])}` }),
  ],
  [
    new RegExp(`\\b${EVERY}\\s+${ORD}\\s+(?:of\\s+)?(${MON})\\b`, 'i'),
    (m) => ({ rrule: `FREQ=YEARLY;BYMONTH=${monthNumber(m[2]!)};BYMONTHDAY=${Number(m[1])}` }),
  ],
  [
    new RegExp(
      `\\b${EVERY}\\s+(other\\s+|\\d+\\s+)?(day|week|month|year)s?\\b(?:\\s+on\\s+(?:the\\s+)?(?:(last\\s+day)|${ORD}|((?:${WD})(?:\\s*(?:,|and|&)?\\s*(?:${WD})\\b)*)))?`,
      'i',
    ),
    (m) => {
      const unit = m[2]!.toLowerCase()
      const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[unit]!
      let rule = `FREQ=${freq}`
      if (freq === 'MONTHLY' && (m[3] || m[4])) rule += `;BYMONTHDAY=${m[3] ? -1 : Number(m[4])}`
      if (freq === 'WEEKLY' && m[5]) {
        const days = [...m[5].matchAll(new RegExp(WD, 'gi'))].map((d) => dayCode(d[0]))
        rule += `;BYDAY=${DAY_CODES.filter((d) => days.includes(d)).join(',')}`
      }
      return { rrule: withInterval(rule, intervalOf(m[1])) }
    },
  ],
  [
    /\b(daily|weekly|monthly|yearly|annually|biweekly|fortnightly)\b/i,
    (m) => {
      const w = m[1]!.toLowerCase()
      const rrule =
        w === 'daily'
          ? 'FREQ=DAILY'
          : w === 'weekly'
            ? 'FREQ=WEEKLY'
            : w === 'monthly'
              ? 'FREQ=MONTHLY'
              : w === 'biweekly' || w === 'fortnightly'
                ? 'FREQ=WEEKLY;INTERVAL=2'
                : 'FREQ=YEARLY'
      return { rrule }
    },
  ],
]

function matchRepeat(text: string): RepeatMatch | null {
  for (const [re, build] of REPEAT_RULES) {
    const m = re.exec(text)
    if (m) return { index: m.index, length: m[0].length, ...build(m) }
  }
  return null
}

// Words chrono reads as dates that are usually just words in a task title ("sat on the couch",
// "march on"). "Sat 9am" or "on sat" still parse because chrono's span then includes more.
const AMBIGUOUS = /^(?:sat|sun|wed|mar|march|may|morning|afternoon|evening|night|now|noon)$/i

let parser: chrono.Chrono | null = null
function getParser(): chrono.Chrono {
  if (parser) return parser
  parser = chrono.casual.clone()
  // "3 days ago" never helps a task, and these two parsers' regexes cost ~70 ms each to tier up
  // on their second run in V8, which would land on the user's second keystroke.
  parser.parsers = parser.parsers.filter((p) => !/TimeUnit(Ago|Later)/.test(p.constructor.name))
  return parser
}

/**
 * Pays chrono's one-time setup (regex compilation, ~30 ms) ahead of the first keystroke. Call on
 * idle when the tasks module loads.
 */
export function warmQuickAdd(): void {
  const now = new Date()
  parseQuickAdd('warm up tomorrow at 5pm every week #x !', { now, lists: [] })
  parseQuickAdd('warm up again friday', { now, lists: [] })
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

export function parseQuickAdd(input: string, ctx: QuickAddContext): QuickAddResult {
  const { now } = ctx
  const tokens: QuickAddToken[] = []
  let masked = input
  const consume = (start: number, end: number, kind: QuickAddTokenKind | null) => {
    if (kind) tokens.push({ kind, start, end, text: input.slice(start, end) })
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end)
  }
  // Pulls a preposition that directly precedes a span ("due on", "at", "by") into it.
  const leadIn = (start: number) => {
    const m = /\b(?:due\s+(?:on|by)|due|on|at|by|before|starting)\s+$/i.exec(masked.slice(0, start))
    return m ? m.index : start
  }

  // "remind me to …" is how people phrase reminders; it means "alert me", not part of the title.
  let remind = false
  const rm = /^\s*remind\s+me\s+(?:to\s+|about\s+)?/i.exec(masked)
  if (rm) {
    remind = true
    consume(0, rm[0].length, null)
  }

  let listName: string | null = null
  for (const m of input.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    const start = m.index + m[1]!.length
    consume(start, start + 1 + m[2]!.length, 'list')
    listName = m[2]!
  }
  const list = listName
    ? (ctx.lists.find((l) => normalizeName(l.name) === normalizeName(listName!)) ?? null)
    : null

  const tags: string[] = []
  for (const m of input.matchAll(/(^|\s)\+(\p{L}[\p{L}\p{N}_-]*)/gu)) {
    const start = m.index + m[1]!.length
    consume(start, start + 1 + m[2]!.length, 'tag')
    if (!tags.includes(m[2]!.toLowerCase())) tags.push(m[2]!.toLowerCase())
  }

  let priority: Priority = 0
  for (const m of input.matchAll(/(^|\s)(!{1,3}|!high|!med(?:ium)?|!low)(?=\s|$)/gi)) {
    const start = m.index + m[1]!.length
    consume(start, start + m[2]!.length, 'priority')
    const word = m[2]!.toLowerCase()
    priority = word === '!low' ? 1 : word.startsWith('!med') ? 2 : 3
  }

  let rrule: string | null = null
  let impliedTime: string | null = null
  const rep = matchRepeat(masked)
  if (rep) {
    rrule = rep.rrule
    impliedTime = rep.time ?? null
    consume(leadIn(rep.index), rep.index + rep.length, 'repeat')
  }

  // "on the 3rd": chrono doesn't read a bare day of month. Next such day, today included.
  let dueDate: string | null = null
  let dateCertain = false
  const dom = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(masked)
  if (dom && Number(dom[1]) >= 1 && Number(dom[1]) <= 31) {
    const day = Number(dom[1])
    const d = new Date(now.getFullYear(), now.getMonth(), 1)
    for (let i = 0; i < 13; i++, d.setMonth(d.getMonth() + 1)) {
      const c = new Date(d.getFullYear(), d.getMonth(), day)
      if (c.getMonth() === d.getMonth() && dateKey(c) >= dateKey(now)) {
        dueDate = dateKey(c)
        break
      }
    }
    if (dueDate) {
      dateCertain = true
      consume(leadIn(dom.index), dom.index + dom[0].length, 'date')
    }
  }

  let dueTime: string | null = impliedTime
  for (const r of getParser().parse(masked, now, { forwardDate: true })) {
    if (AMBIGUOUS.test(r.text)) continue
    const s = r.start
    let end = r.index + r.text.length
    const fromNow = /^\s+from\s+now\b/i.exec(masked.slice(end))
    if (fromNow) end += fromNow[0].length
    consume(leadIn(r.index), end, 'date')
    const dayKnown = s.isCertain('day') || s.isCertain('weekday') || s.isCertain('month')
    if (s.isCertain('hour')) {
      let hour = s.get('hour') ?? 0
      // "at 5" means 5pm for a task; nobody schedules errands for 5am without saying so.
      if (!s.isCertain('meridiem') && hour >= 1 && hour <= 7) hour += 12
      const minute = s.get('minute') ?? 0
      dueTime = timeKey(new Date(2000, 0, 1, hour, minute))
    }
    if (dayKnown && !dueDate) {
      dueDate = dateKey(s.date())
      dateCertain = true
    }
    break
  }

  if (!dateCertain) {
    if (rrule) dueDate = firstOccurrence(rrule, now, dueTime)
    else if (dueTime) {
      // A time alone means the next time it comes round: today if still ahead, else tomorrow.
      const today = dateKey(now)
      dueDate = dueTime > timeKey(now) ? today : addDays(today, 1)
    }
  }

  let alertAt: number | null = null
  if (dueDate && dueTime) alertAt = fromDateKey(dueDate, dueTime).getTime()
  else if (dueDate && remind) alertAt = fromDateKey(dueDate, DEFAULT_ALERT_TIME).getTime()

  tokens.sort((a, b) => a.start - b.start)
  const title = masked.replace(/\s+/g, ' ').trim()
  return {
    title,
    dueDate,
    dueTime: dueDate ? dueTime : null,
    alertAt,
    rrule,
    priority,
    listId: list?.id ?? null,
    listName,
    tags,
    tokens,
  }
}
