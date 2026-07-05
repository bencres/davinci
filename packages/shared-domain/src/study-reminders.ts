/**
 * Study reminders — the PURE decision/formatting core behind the desktop's
 * "cards are due" and "streak at risk" notifications. The Electron main process
 * owns the timers, reads the decks/logs, and shows the `Notification`s; this
 * module answers the testable questions: is it time to fire (once per local
 * day, at/after a configured HH:MM), and what should the notification say.
 * No node/DOM imports — same zero-dependency contract as the rest of shared-domain.
 */

import { localDateKey } from './study-stats'

/** Default local time for the "cards due" reminder. */
export const DEFAULT_DUE_REMINDER_TIME = '09:00'
/** Default local time for the evening "streak at risk" reminder. */
export const DEFAULT_STREAK_REMINDER_TIME = '19:00'

export interface ReminderTime {
  hour: number // 0–23
  minute: number // 0–59
}

/**
 * Parse a user-configured `HH:MM` string, falling back (to another `HH:MM`,
 * assumed valid) on anything malformed — a bad setting should never disable
 * the reminder silently, just restore its default hour.
 */
export function parseReminderTime(raw: string | null | undefined, fallback: string): ReminderTime {
  const parse = (s: string): ReminderTime | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (!m) return null
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
    return { hour, minute }
  }
  return parse(raw ?? '') ?? parse(fallback) ?? { hour: 9, minute: 0 }
}

export interface ReminderFireCheck {
  now: Date
  time: ReminderTime
  /** Local `YYYY-MM-DD` this reminder last fired, or null if never (this run). */
  lastFiredDay: string | null
}

/**
 * A reminder fires at most once per local calendar day, the first time a check
 * lands at/after its configured time. Checking is cheap and periodic (the main
 * process polls every minute), so "at/after" rather than "exactly at" also
 * covers app launches later in the day.
 */
export function reminderShouldFire({ now, time, lastFiredDay }: ReminderFireCheck): boolean {
  const today = localDateKey(now)
  if (lastFiredDay === today) return false
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  return nowMinutes >= time.hour * 60 + time.minute
}

/** Notification body for the "cards due" reminder. */
export function formatDueReminderBody(due: number, fresh: number): string {
  const parts = [`${due} card${due === 1 ? '' : 's'} due`]
  if (fresh > 0) parts.push(`${fresh} new`)
  return parts.join(' · ')
}

/** Notification body for the "streak at risk" reminder. */
export function formatStreakReminderBody(streak: number): string {
  return `Your ${streak}-day streak ends at midnight — a quick review keeps it alive.`
}
