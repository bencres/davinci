import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DUE_REMINDER_TIME,
  formatDueReminderBody,
  formatStreakReminderBody,
  parseReminderTime,
  reminderShouldFire
} from './study-reminders'
import { localDateKey } from './study-stats'

describe('parseReminderTime', () => {
  it('parses valid HH:MM strings', () => {
    expect(parseReminderTime('09:00', '19:00')).toEqual({ hour: 9, minute: 0 })
    expect(parseReminderTime('23:59', '19:00')).toEqual({ hour: 23, minute: 59 })
    expect(parseReminderTime(' 7:30 ', '19:00')).toEqual({ hour: 7, minute: 30 })
  })

  it('falls back on malformed or out-of-range input', () => {
    expect(parseReminderTime('24:00', DEFAULT_DUE_REMINDER_TIME)).toEqual({ hour: 9, minute: 0 })
    expect(parseReminderTime('12:60', DEFAULT_DUE_REMINDER_TIME)).toEqual({ hour: 9, minute: 0 })
    expect(parseReminderTime('noon', DEFAULT_DUE_REMINDER_TIME)).toEqual({ hour: 9, minute: 0 })
    expect(parseReminderTime(null, '19:00')).toEqual({ hour: 19, minute: 0 })
    expect(parseReminderTime(undefined, '19:00')).toEqual({ hour: 19, minute: 0 })
  })
})

describe('reminderShouldFire', () => {
  const time = { hour: 9, minute: 0 }
  const at = (h: number, m: number): Date => new Date(2026, 6, 3, h, m) // 2026-07-03 local

  it('fires at/after the configured time when it has not fired today', () => {
    expect(reminderShouldFire({ now: at(9, 0), time, lastFiredDay: null })).toBe(true)
    expect(reminderShouldFire({ now: at(15, 30), time, lastFiredDay: null })).toBe(true)
  })

  it('does not fire before the configured time', () => {
    expect(reminderShouldFire({ now: at(8, 59), time, lastFiredDay: null })).toBe(false)
  })

  it('fires at most once per local day', () => {
    const today = localDateKey(at(9, 5))
    expect(reminderShouldFire({ now: at(9, 5), time, lastFiredDay: today })).toBe(false)
    // …but a stamp from yesterday does not block today.
    expect(reminderShouldFire({ now: at(9, 5), time, lastFiredDay: '2026-07-02' })).toBe(true)
  })
})

describe('notification bodies', () => {
  it('formats due counts with singular/plural and optional new cards', () => {
    expect(formatDueReminderBody(1, 0)).toBe('1 card due')
    expect(formatDueReminderBody(12, 5)).toBe('12 cards due · 5 new')
  })

  it('formats the streak warning', () => {
    expect(formatStreakReminderBody(7)).toBe(
      'Your 7-day streak ends at midnight — a quick review keeps it alive.'
    )
  })
})
