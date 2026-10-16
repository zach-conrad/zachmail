/** Option sets for the D (due), H (remind) and L (move) pickers. Pure, so they're testable. */
import {
  addDays,
  dateKey,
  DEFAULT_ALERT_TIME,
  describeRRule,
  fromDateKey,
  parseQuickAdd,
  type Clock,
  type TaskList,
  type TaskPatch,
} from '@zachhub/tasks-core'
import { formatAlert, formatDay, formatDue, listColor } from './format'
import { fuzzy, type PickerOption } from './Picker'

const nextWeekday = (clock: Clock, weekday: number) => {
  const d = fromDateKey(clock.today)
  const diff = (weekday - d.getDay() + 7) % 7 || 7
  return addDays(clock.today, diff)
}

/** D: preset days, or anything quick add understands ("fri 3pm", "every monday"). */
export function dueOptions(
  query: string,
  clock: Clock,
  now: Date,
  apply: (patch: TaskPatch) => void,
): PickerOption[] {
  const presets: { id: string; label: string; date: string | null }[] = [
    { id: 'today', label: 'Today', date: clock.today },
    { id: 'tomorrow', label: 'Tomorrow', date: addDays(clock.today, 1) },
    { id: 'weekend', label: 'This weekend', date: nextWeekday(clock, 6) },
    { id: 'nextweek', label: 'Next week', date: nextWeekday(clock, 1) },
    { id: 'none', label: 'No due date', date: null },
  ]
  const out: PickerOption[] = []
  if (query.trim()) {
    const p = parseQuickAdd(query, { now, lists: [] })
    if (p.dueDate) {
      const patch: TaskPatch = { dueDate: p.dueDate, dueTime: p.dueTime }
      if (p.rrule) patch.rrule = p.rrule
      if (p.dueTime) patch.alertAt = fromDateKey(p.dueDate, p.dueTime).getTime()
      out.push({
        id: 'parsed',
        label: formatDue(p.dueDate, p.dueTime, clock),
        hint: p.rrule ? describeRRule(p.rrule) : undefined,
        run: () => apply(patch),
      })
    }
  }
  for (const o of presets) {
    if (fuzzy(query, o.label) < 0) continue
    out.push({
      id: o.id,
      label: o.label,
      hint: o.date ? formatDay(o.date, clock) : undefined,
      run: () =>
        apply(o.date ? { dueDate: o.date } : { dueDate: null, dueTime: null, rrule: null }),
    })
  }
  return out
}

/**
 * H: when to alert. Setting an alert on an undated task also dates it, so a reminder always
 * shows up in Today when it fires.
 */
export function remindOptions(
  query: string,
  clock: Clock,
  now: Date,
  hasDue: boolean,
  apply: (patch: TaskPatch) => void,
): PickerOption[] {
  const at = (date: string, time: string) => fromDateKey(date, time).getTime()
  const later = new Date(now.getTime() + 3 * 3_600_000)
  later.setMinutes(0, 0, 0)
  const presets: { id: string; label: string; at: number | null }[] = [
    { id: 'later', label: 'Later today', at: later.getTime() },
    { id: 'evening', label: 'This evening', at: at(clock.today, '18:00') },
    {
      id: 'tomorrow',
      label: 'Tomorrow morning',
      at: at(addDays(clock.today, 1), DEFAULT_ALERT_TIME),
    },
    { id: 'nextweek', label: 'Next week', at: at(nextWeekday(clock, 1), DEFAULT_ALERT_TIME) },
    { id: 'none', label: 'No alert', at: null },
  ]
  const patchFor = (t: number | null): TaskPatch => {
    if (t === null) return { alertAt: null }
    return hasDue ? { alertAt: t } : { alertAt: t, dueDate: dateKey(new Date(t)) }
  }
  const out: PickerOption[] = []
  if (query.trim()) {
    const p = parseQuickAdd(query, { now, lists: [] })
    if (p.dueDate) {
      const t = at(p.dueDate, p.dueTime ?? DEFAULT_ALERT_TIME)
      out.push({ id: 'parsed', label: formatAlert(t, clock), run: () => apply(patchFor(t)) })
    }
  }
  for (const o of presets) {
    // "This evening" is gone once the evening has started.
    if (o.at !== null && o.at <= now.getTime()) continue
    if (fuzzy(query, o.label) < 0) continue
    out.push({
      id: o.id,
      label: o.label,
      hint: o.at !== null ? formatAlert(o.at, clock) : undefined,
      run: () => apply(patchFor(o.at)),
    })
  }
  return out
}

/** L: Inbox and every list, fuzzy-filtered, plus "create" for a name that doesn't exist. */
export function listOptions(
  query: string,
  lists: readonly TaskList[],
  currentId: string | null,
  move: (listId: string | null) => void,
  create: (name: string) => void,
): PickerOption[] {
  const all = [
    {
      id: 'inbox',
      label: 'Inbox',
      listId: null as string | null,
      color: undefined as string | undefined,
    },
    ...lists.map((l) => ({
      id: l.id,
      label: l.name,
      listId: l.id as string | null,
      color: listColor(l.color),
    })),
  ]
  const out = all
    .map((o) => ({ o, score: fuzzy(query, o.label) }))
    .filter((r) => r.score >= 0 && r.o.listId !== currentId)
    .sort((a, b) => b.score - a.score)
    .map(({ o }) => ({
      id: o.id,
      label: o.label,
      color: o.color,
      run: () => move(o.listId),
    }))
  const name = query.trim()
  if (name && !all.some((o) => o.label.toLowerCase() === name.toLowerCase()))
    out.push({
      id: 'create',
      label: `New list “${name}”`,
      color: undefined,
      run: () => create(name),
    })
  return out
}
