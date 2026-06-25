/**
 * Study dashboard statistics — the gamification layer over the existing
 * spaced-repetition data. PURE (no node/DOM imports) so it is unit-testable and
 * shared by the renderer; it aggregates the same deck files and append-only
 * review logs the study loop already produces (see `flashcards.ts` / `srs.ts`).
 *
 * Two shapes matter: `StudyGamification` is the small PERSISTED config (editable
 * daily goal + streak bookkeeping), and `StudyStats` is fully DERIVED on demand
 * from decks + logs + that config — never stored.
 */

import type { Flashcard, FlashcardDeck, ReviewLogFile } from './flashcards'
import { isDue, isNew } from './srs'

// ---------------------------------------------------------------------------
// Persisted gamification config (stored at `.zennotes/flashcards/gamification.json`).
// ---------------------------------------------------------------------------

export const STUDY_GAMIFICATION_VERSION = 1

export interface StudyGamification {
  version: typeof STUDY_GAMIFICATION_VERSION
  /** Cards/day target driving the goal ring (and a "goal met" day). */
  dailyGoal: number
  /** Available streak freezes (each can bridge one missed day). Reserved for future UI. */
  streakFreezes: number
  /** Local `YYYY-MM-DD` dates a freeze was consumed; these bridge a gap in the streak. */
  freezeUsedDates: string[]
}

export const DEFAULT_STUDY_DAILY_GOAL = 20

export const DEFAULT_STUDY_GAMIFICATION: StudyGamification = {
  version: STUDY_GAMIFICATION_VERSION,
  dailyGoal: DEFAULT_STUDY_DAILY_GOAL,
  streakFreezes: 0,
  freezeUsedDates: []
}

/** Coerce arbitrary parsed JSON into a valid `StudyGamification` (defaults on miss). */
export function normalizeGamification(raw: unknown): StudyGamification {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<StudyGamification>
  const goal = Number(obj.dailyGoal)
  const freezes = Number(obj.streakFreezes)
  return {
    version: STUDY_GAMIFICATION_VERSION,
    dailyGoal: Number.isFinite(goal) && goal > 0 ? Math.round(goal) : DEFAULT_STUDY_DAILY_GOAL,
    streakFreezes: Number.isFinite(freezes) && freezes > 0 ? Math.round(freezes) : 0,
    freezeUsedDates: Array.isArray(obj.freezeUsedDates)
      ? obj.freezeUsedDates.filter((d): d is string => typeof d === 'string')
      : []
  }
}

// ---------------------------------------------------------------------------
// Derived stats.
// ---------------------------------------------------------------------------

/** A card is "mature" once FSRS stability reaches this many days (Anki convention). */
export const MATURE_DAYS = 21

export interface HeatmapDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string
  /** Reviews recorded on that day. */
  count: number
}

export interface ConceptMastery {
  concept: string
  total: number
  mature: number
  /** good+easy / graded, across reviews of cards tagged with this concept (0..1). */
  accuracy: number
  /** 0..100, the mean per-card FSRS stability clamped against `MATURE_DAYS`. */
  masteryPct: number
  /** The note(s) backing this concept; a single entry enables a focused study jump. */
  notePaths: string[]
}

export interface StudyStats {
  reviewsToday: number
  dailyGoal: number
  /** Whether today's reviews already met the goal. */
  goalMet: boolean
  /** Consecutive active days ending today (or yesterday, if today is not over yet). */
  currentStreak: number
  longestStreak: number
  totalCards: number
  /** Cards whose `due` has arrived (matches what a global study session would queue). */
  dueToday: number
  /** Cards never scheduled yet. */
  newAvailable: number
  matureCards: number
  /** good+easy / total graded, all time (0..1). */
  retentionRate: number
  totalReviews: number
  /** Continuous daily counts for the trailing year, oldest-first (fills a heatmap grid). */
  heatmap: HeatmapDay[]
  /** Per-concept mastery, largest concepts first. */
  concepts: ConceptMastery[]
}

/** Trailing days to render in the activity heatmap (53 weeks). */
export const HEATMAP_DAYS = 371

// --- Local-day helpers (mirror `isSameLocalDay` in flashcards.ts) ---

/** Local `YYYY-MM-DD` for a Date (calendar day in the viewer's timezone). */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local midnight Date for a `YYYY-MM-DD` key. */
function dateFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

// --- Streak math ---

/**
 * Consecutive active days ending today. A day is "active" if it has ≥1 review;
 * a frozen day (in `freezeDays`) bridges a gap without adding to the count. Today
 * not yet being active does NOT break the streak (the day isn't over) — counting
 * then resumes from yesterday.
 */
export function computeCurrentStreak(
  activeDays: ReadonlySet<string>,
  freezeDays: ReadonlySet<string>,
  now: Date
): number {
  let cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayKey = localDateKey(cursor)
  if (!activeDays.has(todayKey) && !freezeDays.has(todayKey)) {
    cursor = addDays(cursor, -1) // today still in progress — judge from yesterday
  }
  let streak = 0
  for (;;) {
    const key = localDateKey(cursor)
    if (activeDays.has(key)) streak++
    else if (!freezeDays.has(key)) break
    cursor = addDays(cursor, -1)
  }
  return streak
}

/** Longest run of consecutive covered days (active ∪ frozen), counting active days only. */
export function computeLongestStreak(
  activeDays: ReadonlySet<string>,
  freezeDays: ReadonlySet<string>
): number {
  const covered = new Set<string>([...activeDays, ...freezeDays])
  let best = 0
  for (const day of activeDays) {
    const prev = localDateKey(addDays(dateFromKey(day), -1))
    if (covered.has(prev)) continue // not a run start
    let cursor = dateFromKey(day)
    let count = 0
    for (;;) {
      const key = localDateKey(cursor)
      if (!covered.has(key)) break
      if (activeDays.has(key)) count++
      cursor = addDays(cursor, 1)
    }
    if (count > best) best = count
  }
  return best
}

// --- Main aggregation ---

function isCorrect(rating: string): boolean {
  return rating === 'good' || rating === 'easy'
}

function cardMastery(card: Flashcard): number {
  const s = card.srs.stability
  if (s == null || !Number.isFinite(s) || s <= 0) return 0
  return Math.min(1, s / MATURE_DAYS)
}

function isMature(card: Flashcard): boolean {
  return (
    card.srs.state === 'review' && card.srs.stability != null && card.srs.stability >= MATURE_DAYS
  )
}

/** Aggregate every deck + review log (plus the persisted config) into dashboard stats. */
export function computeStudyStats(
  decks: FlashcardDeck[],
  logs: ReviewLogFile[],
  gam: StudyGamification,
  now: Date = new Date()
): StudyStats {
  const nowMs = now.getTime()
  const todayKey = localDateKey(now)

  // --- Card-level rollups ---
  const cardById = new Map<string, Flashcard>()
  const noteByCardId = new Map<string, string>()
  let totalCards = 0
  let dueToday = 0
  let newAvailable = 0
  let matureCards = 0
  for (const deck of decks) {
    for (const card of deck.cards) {
      totalCards++
      cardById.set(card.id, card)
      noteByCardId.set(card.id, deck.sourceNotePath)
      if (isNew(card.srs)) newAvailable++
      else if (isDue(card.srs, nowMs)) dueToday++
      if (isMature(card)) matureCards++
    }
  }

  // --- Review-log rollups (heatmap, streak, retention, per-concept accuracy) ---
  const countsByDay = new Map<string, number>()
  let totalReviews = 0
  let correctReviews = 0
  // concept → { graded, correct } from review history
  const conceptGrades = new Map<string, { graded: number; correct: number }>()
  for (const log of logs) {
    for (const g of log.grades) {
      const t = new Date(g.reviewedAt)
      if (Number.isNaN(t.getTime())) continue
      const key = localDateKey(t)
      countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1)
      totalReviews++
      const correct = isCorrect(g.rating)
      if (correct) correctReviews++
      const card = cardById.get(g.cardId)
      if (card) {
        for (const concept of card.concepts) {
          const acc = conceptGrades.get(concept) ?? { graded: 0, correct: 0 }
          acc.graded++
          if (correct) acc.correct++
          conceptGrades.set(concept, acc)
        }
      }
    }
  }

  const reviewsToday = countsByDay.get(todayKey) ?? 0
  const activeDays = new Set<string>(
    [...countsByDay.entries()].filter(([, c]) => c > 0).map(([d]) => d)
  )
  const freezeDays = new Set<string>(gam.freezeUsedDates)

  // --- Heatmap: continuous trailing year, oldest-first ---
  const heatmap: HeatmapDay[] = []
  const start = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -(HEATMAP_DAYS - 1))
  for (let i = 0; i < HEATMAP_DAYS; i++) {
    const key = localDateKey(addDays(start, i))
    heatmap.push({ date: key, count: countsByDay.get(key) ?? 0 })
  }

  // --- Per-concept mastery ---
  const conceptCards = new Map<string, Flashcard[]>()
  const conceptNotes = new Map<string, Set<string>>()
  for (const deck of decks) {
    for (const card of deck.cards) {
      for (const concept of card.concepts) {
        const list = conceptCards.get(concept) ?? []
        list.push(card)
        conceptCards.set(concept, list)
        const notes = conceptNotes.get(concept) ?? new Set<string>()
        notes.add(deck.sourceNotePath)
        conceptNotes.set(concept, notes)
      }
    }
  }
  const concepts: ConceptMastery[] = [...conceptCards.entries()]
    .map(([concept, cards]) => {
      const grades = conceptGrades.get(concept)
      const masterySum = cards.reduce((sum, c) => sum + cardMastery(c), 0)
      return {
        concept,
        total: cards.length,
        mature: cards.filter(isMature).length,
        accuracy: grades && grades.graded > 0 ? grades.correct / grades.graded : 0,
        masteryPct: cards.length > 0 ? Math.round((masterySum / cards.length) * 100) : 0,
        notePaths: [...(conceptNotes.get(concept) ?? [])]
      }
    })
    .sort((a, b) => b.total - a.total || a.concept.localeCompare(b.concept))

  return {
    reviewsToday,
    dailyGoal: gam.dailyGoal,
    goalMet: reviewsToday >= gam.dailyGoal,
    currentStreak: computeCurrentStreak(activeDays, freezeDays, now),
    longestStreak: computeLongestStreak(activeDays, freezeDays),
    totalCards,
    dueToday,
    newAvailable,
    matureCards,
    retentionRate: totalReviews > 0 ? correctReviews / totalReviews : 0,
    totalReviews,
    heatmap,
    concepts
  }
}
