/**
 * Study reminders — desktop-only OS notifications while the app is running:
 * "cards are due" at a configured morning time, and "streak at risk" in the
 * evening when a streak would break at midnight. Both are opt-in via vault
 * settings and fire at most once per local day (in-memory stamp: a same-day
 * app restart may re-fire once — accepted v1 trade-off).
 *
 * The timers and file reads live here; the once-per-day/at-time decision and
 * the notification copy are pure shared-domain logic (`@shared/study-reminders`)
 * so they stay unit-tested. Clicking a notification focuses the app and opens
 * the study dashboard (mirrors the updater's settings notification).
 */

import { BrowserWindow, Notification } from 'electron'
import {
  DEFAULT_FLASHCARD_DUE_REMINDER_TIME,
  DEFAULT_FLASHCARD_STREAK_REMINDER_TIME,
  IPC
} from '@shared/ipc'
import { splitNewVsReview } from '@shared/srs'
import { computeCurrentStreak, localDateKey } from '@shared/study-stats'
import {
  formatDueReminderBody,
  formatStreakReminderBody,
  parseReminderTime,
  reminderShouldFire
} from '@shared/study-reminders'
import { buildCardIndex, type ReviewLogFile } from '@shared/flashcards'
import {
  listFlashcardDecks,
  readFlashcards,
  readReviewLog,
  readStudyGamification
} from './flashcards'
import { getVaultSettings } from './vault'

const CHECK_INTERVAL_MS = 60_000
/** Give the window/vault a moment to settle before the first check. */
const FIRST_CHECK_DELAY_MS = 5_000

let timer: NodeJS.Timeout | null = null
let getRoot: (() => string | null) | null = null
/** Local `YYYY-MM-DD` each reminder type last fired (this run). */
const lastFired: { due: string | null; streak: string | null } = { due: null, streak: null }

/**
 * Start the once-a-minute reminder check. `rootProvider` returns the active
 * LOCAL vault root, or null when none/remote — the check is then a no-op, so
 * this is safe to call once at app startup and forget.
 */
export function initStudyReminders(rootProvider: () => string | null): void {
  getRoot = rootProvider
  if (timer) return
  timer = setInterval(() => void checkStudyReminders(), CHECK_INTERVAL_MS)
  setTimeout(() => void checkStudyReminders(), FIRST_CHECK_DELAY_MS)
}

async function checkStudyReminders(): Promise<void> {
  const root = getRoot?.() ?? null
  if (!root || !Notification.isSupported()) return
  let settings
  try {
    settings = await getVaultSettings(root)
  } catch {
    return // vault mid-switch or unreadable — try again next minute
  }
  const now = new Date()

  if (settings.flashcardDueReminderEnabled === true) {
    const time = parseReminderTime(
      settings.flashcardDueReminderTime,
      DEFAULT_FLASHCARD_DUE_REMINDER_TIME
    )
    if (reminderShouldFire({ now, time, lastFiredDay: lastFired.due })) {
      // Stamp before the async reads so an overlapping tick can't double-fire.
      lastFired.due = localDateKey(now)
      try {
        const { due, fresh } = await countDueCards(root, now)
        if (due > 0) showStudyNotification('Time to study', formatDueReminderBody(due, fresh))
      } catch (err) {
        console.error('study due reminder failed', err)
      }
    }
  }

  if (settings.flashcardStreakReminderEnabled === true) {
    const time = parseReminderTime(
      settings.flashcardStreakReminderTime,
      DEFAULT_FLASHCARD_STREAK_REMINDER_TIME
    )
    if (reminderShouldFire({ now, time, lastFiredDay: lastFired.streak })) {
      lastFired.streak = localDateKey(now)
      try {
        const streak = await streakAtRisk(root, now)
        if (streak > 0) showStudyNotification('Streak at risk', formatStreakReminderBody(streak))
      } catch (err) {
        console.error('study streak reminder failed', err)
      }
    }
  }
}

async function loadReviewLogs(root: string): Promise<ReviewLogFile[]> {
  const summaries = await listFlashcardDecks(root)
  const logs: ReviewLogFile[] = []
  for (const s of summaries) {
    try {
      const log = await readReviewLog(root, s.sourceNotePath)
      if (log) logs.push(log)
    } catch {
      // a missing/corrupt log just means no recorded history for that note
    }
  }
  return logs
}

/** Currently-due and never-scheduled card counts across every deck. */
async function countDueCards(root: string, now: Date): Promise<{ due: number; fresh: number }> {
  const summaries = await listFlashcardDecks(root)
  const decks = []
  for (const s of summaries) {
    const deck = await readFlashcards(root, s.sourceNotePath)
    if (deck) decks.push(deck)
  }
  const { newIds, dueIds } = splitNewVsReview(buildCardIndex(decks), now)
  return { due: dueIds.length, fresh: newIds.length }
}

/**
 * The streak that would break at midnight: 0 when the learner already reviewed
 * today (or has no streak), otherwise the current streak counted from yesterday.
 */
async function streakAtRisk(root: string, now: Date): Promise<number> {
  const logs = await loadReviewLogs(root)
  const todayKey = localDateKey(now)
  const activeDays = new Set<string>()
  for (const log of logs) {
    for (const g of log.grades) {
      const t = new Date(g.reviewedAt)
      if (Number.isNaN(t.getTime())) continue
      const key = localDateKey(t)
      if (key === todayKey) return 0 // already reviewed today — nothing at risk
      activeDays.add(key)
    }
  }
  const gam = await readStudyGamification(root)
  return computeCurrentStreak(activeDays, new Set(gam.freezeUsedDates), now)
}

function showStudyNotification(title: string, body: string): void {
  const notification = new Notification({ title, body })
  notification.on('click', focusAppAndOpenStudyDashboard)
  notification.show()
}

/** Mirror of the updater's focus-and-open-settings, aimed at the dashboard. */
function focusAppAndOpenStudyDashboard(): void {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  const target = BrowserWindow.getFocusedWindow() ?? windows[0] ?? null
  if (!target) return
  if (target.isMinimized()) target.restore()
  if (!target.isVisible()) target.show()
  target.focus()
  for (const win of windows) {
    win.webContents.send(IPC.APP_OPEN_STUDY_DASHBOARD)
  }
}
