import { describe, expect, it } from 'vitest'
import { fromDateKey } from './dates'
import { parseQuickAdd, warmQuickAdd, type QuickAddResult } from './quickadd'

// Thursday 15 Oct 2026, 2pm local.
const now = new Date(2026, 9, 15, 14, 0)
const lists = [
  { id: 'l-home', name: 'Home' },
  { id: 'l-work', name: 'Work Stuff' },
]
const parse = (s: string) => parseQuickAdd(s, { now, lists })
const pick = (r: QuickAddResult, ...keys: (keyof QuickAddResult)[]) =>
  Object.fromEntries(keys.map((k) => [k, r[k]]))

describe('parseQuickAdd', () => {
  it('parses the spec example', () => {
    const r = parse('pay rent every 1st at 9am #home !')
    expect(r).toMatchObject({
      title: 'pay rent',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
      dueDate: '2026-11-01',
      dueTime: '09:00',
      listId: 'l-home',
      priority: 3,
    })
    expect(r.alertAt).toBe(fromDateKey('2026-11-01', '09:00').getTime())
    expect(r.tokens.map((t) => [t.kind, t.text])).toEqual([
      ['repeat', 'every 1st'],
      ['date', 'at 9am'],
      ['list', '#home'],
      ['priority', '!'],
    ])
  })

  it('leaves plain titles alone', () => {
    for (const s of [
      'buy 2 apples',
      'read chapter 5',
      'fix bug 404',
      'sat on the couch',
      'march on',
    ]) {
      const r = parse(s)
      expect(pick(r, 'title', 'dueDate', 'rrule')).toEqual({ title: s, dueDate: null, rrule: null })
    }
  })

  it('reads dates and times', () => {
    expect(pick(parse('call mom tomorrow 5pm'), 'title', 'dueDate', 'dueTime')).toEqual({
      title: 'call mom',
      dueDate: '2026-10-16',
      dueTime: '17:00',
    })
    expect(pick(parse('dentist next tue'), 'title', 'dueDate', 'dueTime')).toEqual({
      title: 'dentist',
      dueDate: '2026-10-20',
      dueTime: null,
    })
    expect(pick(parse('taxes due apr 15'), 'title', 'dueDate')).toEqual({
      title: 'taxes',
      dueDate: '2027-04-15',
    })
    expect(pick(parse('review deck on friday'), 'title', 'dueDate')).toEqual({
      title: 'review deck',
      dueDate: '2026-10-16',
    })
    expect(pick(parse('ship it in 3 days'), 'title', 'dueDate')).toEqual({
      title: 'ship it',
      dueDate: '2026-10-18',
    })
    expect(pick(parse('ship it 3 days from now'), 'title', 'dueDate')).toEqual({
      title: 'ship it',
      dueDate: '2026-10-18',
    })
    expect(pick(parse('invoice on the 3rd'), 'title', 'dueDate')).toEqual({
      title: 'invoice',
      dueDate: '2026-11-03',
    })
    expect(pick(parse('invoice the 20th'), 'title', 'dueDate')).toEqual({
      title: 'invoice',
      dueDate: '2026-10-20',
    })
  })

  it('treats a bare time as the next time it comes round, pm for small hours', () => {
    expect(pick(parse('call at 5'), 'dueDate', 'dueTime')).toEqual({
      dueDate: '2026-10-15',
      dueTime: '17:00',
    })
    expect(pick(parse('standup at 9am'), 'dueDate', 'dueTime')).toEqual({
      dueDate: '2026-10-16',
      dueTime: '09:00',
    })
    expect(pick(parse('standup at 9:30'), 'dueDate', 'dueTime')).toEqual({
      dueDate: '2026-10-16',
      dueTime: '09:30',
    })
  })

  it('sets an alert when there is a time, or for "remind me to" on a date', () => {
    expect(parse('call mom tomorrow').alertAt).toBeNull()
    const r = parse('remind me to call mom tomorrow')
    expect(r.title).toBe('call mom')
    expect(r.alertAt).toBe(fromDateKey('2026-10-16', '09:00').getTime())
    expect(parse('remind me to breathe').alertAt).toBeNull()
  })

  it.each([
    ['water plants every day', 'FREQ=DAILY', '2026-10-15'],
    ['water plants daily', 'FREQ=DAILY', '2026-10-15'],
    ['gym every other day', 'FREQ=DAILY;INTERVAL=2', '2026-10-15'],
    ['report every weekday', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', '2026-10-15'],
    ['brunch every weekend', 'FREQ=WEEKLY;BYDAY=SA,SU', '2026-10-17'],
    ['trash every monday', 'FREQ=WEEKLY;BYDAY=MO', '2026-10-19'],
    ['class every tue and thu', 'FREQ=WEEKLY;BYDAY=TU,TH', '2026-10-15'],
    ['1:1 every other wednesday', 'FREQ=WEEKLY;BYDAY=WE;INTERVAL=2', '2026-10-21'],
    ['sync every 2 weeks', 'FREQ=WEEKLY;INTERVAL=2', '2026-10-15'],
    ['backup every week on fri', 'FREQ=WEEKLY;BYDAY=FR', '2026-10-16'],
    ['bills every month on the 15th', 'FREQ=MONTHLY;BYMONTHDAY=15', '2026-10-15'],
    ['close books every last day of the month', 'FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-31'],
    ['book club every first tuesday', 'FREQ=MONTHLY;BYDAY=1TU', '2026-11-03'],
    ['payroll every last friday', 'FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30'],
    ['birthday every jan 4', 'FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=4', '2027-01-04'],
    ['taxes every 15th of april', 'FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15', '2027-04-15'],
    ['review every year', 'FREQ=YEARLY', '2026-10-15'],
  ])('%s', (input, rrule, dueDate) => {
    const r = parse(input)
    expect(r.rrule).toBe(rrule)
    expect(r.dueDate).toBe(dueDate)
    expect(r.title).toBe(input.split(/ every| daily/)[0])
  })

  it('starts a timed series after now', () => {
    // 9am today has passed, so a daily 9am series starts tomorrow.
    expect(pick(parse('meds every day at 9am'), 'dueDate', 'dueTime')).toEqual({
      dueDate: '2026-10-16',
      dueTime: '09:00',
    })
    expect(pick(parse('journal every evening'), 'title', 'dueDate', 'dueTime', 'rrule')).toEqual({
      title: 'journal',
      dueDate: '2026-10-15',
      dueTime: '18:00',
      rrule: 'FREQ=DAILY',
    })
  })

  it('reads lists, tags and priorities', () => {
    const r = parse('deck #workstuff +q4 +Deck !med')
    expect(pick(r, 'title', 'listId', 'listName', 'tags', 'priority')).toEqual({
      title: 'deck',
      listId: 'l-work',
      listName: 'workstuff',
      tags: ['q4', 'deck'],
      priority: 2,
    })
    const unknown = parse('paint #garage')
    expect(pick(unknown, 'listId', 'listName')).toEqual({ listId: null, listName: 'garage' })
    expect(parse('call +1 555 1234').tags).toEqual([])
    expect(parse('wow!').priority).toBe(0)
  })

  it('stays under the 16 ms keystroke budget once warm', () => {
    warmQuickAdd()
    const inputs = [
      'pay rent every 1st at 9am #home !',
      'call mom tomorrow 5pm',
      'dentist next tue at 3:30pm for the cleaning with dr smith #health +teeth',
      'a fairly long title with no dates in it at all just words and more words',
      'book club every first tuesday at 7pm',
    ]
    // Typing: every prefix of every input, as the field re-parses on each keystroke. Each
    // keystroke keeps its best of three runs and the percentile allows a few slow ones, so a
    // GC pause or a descheduled thread on a busy CI runner doesn't fail the build.
    const times: number[] = []
    for (const s of inputs)
      for (let i = 1; i <= s.length; i++) {
        let best = Infinity
        for (let r = 0; r < 3; r++) {
          const t0 = performance.now()
          parse(s.slice(0, i))
          best = Math.min(best, performance.now() - t0)
        }
        times.push(best)
      }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length * 0.5)]).toBeLessThan(2)
    expect(times[Math.floor(times.length * 0.98)]).toBeLessThan(16)
  })
})
