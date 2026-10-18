import { describe, expect, it } from 'vitest'
import { describeRRule, firstOccurrence, isValidRRule, nextInstance } from './recurrence'

describe('nextInstance', () => {
  it('steps from the due date', () => {
    expect(nextInstance('FREQ=MONTHLY;BYMONTHDAY=1', '2026-11-01', '09:00', '2026-10-30')).toEqual({
      dueDate: '2026-12-01',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
    })
    expect(nextInstance('FREQ=WEEKLY;INTERVAL=2', '2026-10-15', null, '2026-10-15')?.dueDate).toBe(
      '2026-10-29',
    )
    expect(nextInstance('FREQ=WEEKLY;BYDAY=TU,TH', '2026-10-15', null, '2026-10-15')?.dueDate).toBe(
      '2026-10-20',
    )
  })

  it('skips occurrences already past instead of leaving a backlog', () => {
    // Rent due 1 Aug, ticked off on 15 Oct: next is 1 Nov, not 1 Sep.
    expect(
      nextInstance('FREQ=MONTHLY;BYMONTHDAY=1', '2026-08-01', null, '2026-10-15')?.dueDate,
    ).toBe('2026-11-01')
    // ...but a daily task completed late still lands today, which is not past.
    expect(nextInstance('FREQ=DAILY', '2026-10-10', null, '2026-10-15')?.dueDate).toBe('2026-10-15')
  })

  it('restarts from today when the task had no due date', () => {
    expect(nextInstance('FREQ=DAILY', null, null, '2026-10-15')?.dueDate).toBe('2026-10-16')
  })

  it('handles month ends and leap days', () => {
    expect(
      nextInstance('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31', null, '2026-01-31')?.dueDate,
    ).toBe('2026-02-28')
    expect(nextInstance('FREQ=YEARLY', '2028-02-29', null, '2028-02-29')?.dueDate).toBe(
      '2032-02-29',
    )
  })

  it('counts COUNT down and ends the series', () => {
    expect(nextInstance('FREQ=DAILY;COUNT=3', '2026-10-15', null, '2026-10-15')).toEqual({
      dueDate: '2026-10-16',
      rrule: 'FREQ=DAILY;COUNT=2',
    })
    expect(nextInstance('FREQ=DAILY;COUNT=1', '2026-10-15', null, '2026-10-15')).toBeNull()
    expect(
      nextInstance('FREQ=DAILY;UNTIL=20261015T235959Z', '2026-10-15', null, '2026-10-15'),
    ).toBeNull()
  })

  it('rejects garbage', () => {
    expect(isValidRRule('FREQ=DAILY')).toBe(true)
    expect(isValidRRule('nonsense')).toBe(false)
    expect(nextInstance('nonsense', '2026-10-15', null, '2026-10-15')).toBeNull()
  })
})

describe('firstOccurrence', () => {
  const now = new Date(2026, 9, 15, 14, 0) // Thu
  it('includes today unless its time has passed', () => {
    expect(firstOccurrence('FREQ=DAILY', now, null)).toBe('2026-10-15')
    expect(firstOccurrence('FREQ=DAILY', now, '18:00')).toBe('2026-10-15')
    expect(firstOccurrence('FREQ=DAILY', now, '09:00')).toBe('2026-10-16')
  })
  it('starts an every-other series on the next match', () => {
    expect(firstOccurrence('FREQ=WEEKLY;BYDAY=WE;INTERVAL=2', now, null)).toBe('2026-10-21')
  })
})

describe('describeRRule', () => {
  it.each([
    ['FREQ=DAILY', 'Daily'],
    ['FREQ=DAILY;INTERVAL=3', 'Every 3 days'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Weekdays'],
    ['FREQ=WEEKLY;BYDAY=SA,SU', 'Weekends'],
    ['FREQ=WEEKLY;BYDAY=TU,TH', 'Weekly on Tue, Thu'],
    ['FREQ=WEEKLY;BYDAY=WE;INTERVAL=2', 'Every 2 weeks on Wed'],
    ['FREQ=MONTHLY;BYMONTHDAY=1', 'Monthly on the 1st'],
    ['FREQ=MONTHLY;BYMONTHDAY=22', 'Monthly on the 22nd'],
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'Monthly on the last day'],
    ['FREQ=MONTHLY;BYDAY=-1FR', 'Monthly on the last Fri'],
    ['FREQ=MONTHLY;BYDAY=1TU', 'Monthly on the 1st Tue'],
    ['FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15', 'Yearly on Apr 15'],
  ])('%s', (rule, text) => expect(describeRRule(rule)).toBe(text))
})
