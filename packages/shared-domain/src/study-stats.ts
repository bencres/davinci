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

import type { Flashcard, FlashcardDeck, ReviewGrade, ReviewLogFile } from './flashcards'
import { ratingToNumber } from './flashcards'
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
  /** Predicted-vs-actual rating calibration over review history. */
  calibration: CalibrationStats
}

/** How well a learner's pre-reveal prediction matched the actual self-grade. */
export interface CalibrationStats {
  sampleSize: number
  /** Mean |predicted − actual| on the 1–4 scale (0 = perfectly calibrated). */
  meanAbsError: number
  /** Mean (predicted − actual): >0 over-confident, <0 under-confident. */
  signedBias: number
  /** Same metrics over the most recent `CALIBRATION_RECENT_WINDOW` reviews (trend). */
  recent: { sampleSize: number; meanAbsError: number; signedBias: number }
}

/** Most-recent reviews used for the calibration "recent" trend window. */
export const CALIBRATION_RECENT_WINDOW = 100

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

/**
 * Normalized matching key for a free-text concept label (trim + lower-case) so
 * authored variants like "Hash Maps" / " hash maps " collapse to one concept.
 */
export function conceptKey(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * Per-concept mastery rollup across every deck + review log. Shared by the
 * dashboard (`computeStudyStats`) and the concept graph (`buildConceptGraph`).
 * Concepts are merged by `conceptKey` (first-seen label is kept for display).
 * Accuracy is drawn from review history over ALL concepts a graded card carries;
 * mastery is the mean per-card FSRS stability (0..100) over that concept's cards.
 * Sorted largest concepts first (then alphabetical) for stable rendering.
 */
export function computeConceptMastery(
  decks: FlashcardDeck[],
  logs: ReviewLogFile[]
): ConceptMastery[] {
  const cardById = new Map<string, Flashcard>()
  for (const deck of decks) for (const card of deck.cards) cardById.set(card.id, card)

  // key → { graded, correct } from review history
  const conceptGrades = new Map<string, { graded: number; correct: number }>()
  for (const log of logs) {
    for (const g of log.grades) {
      const card = cardById.get(g.cardId)
      if (!card) continue
      const correct = isCorrect(g.rating)
      for (const concept of card.concepts) {
        const key = conceptKey(concept)
        if (!key) continue
        const acc = conceptGrades.get(key) ?? { graded: 0, correct: 0 }
        acc.graded++
        if (correct) acc.correct++
        conceptGrades.set(key, acc)
      }
    }
  }

  // key → { first-seen display label, cards, notes }
  const byKey = new Map<string, { label: string; cards: Flashcard[]; notes: Set<string> }>()
  for (const deck of decks) {
    for (const card of deck.cards) {
      for (const concept of card.concepts) {
        const key = conceptKey(concept)
        if (!key) continue
        const entry = byKey.get(key) ?? { label: concept.trim(), cards: [], notes: new Set<string>() }
        entry.cards.push(card)
        entry.notes.add(deck.sourceNotePath)
        byKey.set(key, entry)
      }
    }
  }

  return [...byKey.entries()]
    .map(([key, { label, cards, notes }]) => {
      const grades = conceptGrades.get(key)
      const masterySum = cards.reduce((sum, c) => sum + cardMastery(c), 0)
      return {
        concept: label,
        total: cards.length,
        mature: cards.filter(isMature).length,
        accuracy: grades && grades.graded > 0 ? grades.correct / grades.graded : 0,
        masteryPct: cards.length > 0 ? Math.round((masterySum / cards.length) * 100) : 0,
        notePaths: [...notes]
      }
    })
    .sort((a, b) => b.total - a.total || a.concept.localeCompare(b.concept))
}

/**
 * Predicted-vs-actual calibration across review grades. Each grade records the
 * learner's pre-reveal `predictedRating` and the actual `rating`; this measures
 * how close they were (mean absolute error) and which way they lean (signed
 * bias), overall and over the most recent window. Pure and order-independent —
 * grades are sorted by `reviewedAt` internally so the "recent" slice is correct.
 */
export function computeCalibration(grades: ReviewGrade[]): CalibrationStats {
  const rows = grades
    .map((g) => ({
      at: Date.parse(g.reviewedAt),
      diff: ratingToNumber(g.predictedRating) - ratingToNumber(g.rating)
    }))
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.diff))
    .sort((a, b) => a.at - b.at)

  const summarize = (rs: { diff: number }[]): { sampleSize: number; meanAbsError: number; signedBias: number } => {
    if (rs.length === 0) return { sampleSize: 0, meanAbsError: 0, signedBias: 0 }
    let abs = 0
    let signed = 0
    for (const r of rs) {
      abs += Math.abs(r.diff)
      signed += r.diff
    }
    return { sampleSize: rs.length, meanAbsError: abs / rs.length, signedBias: signed / rs.length }
  }

  return { ...summarize(rows), recent: summarize(rows.slice(-CALIBRATION_RECENT_WINDOW)) }
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
  let totalCards = 0
  let dueToday = 0
  let newAvailable = 0
  let matureCards = 0
  for (const deck of decks) {
    for (const card of deck.cards) {
      totalCards++
      if (isNew(card.srs)) newAvailable++
      else if (isDue(card.srs, nowMs)) dueToday++
      if (isMature(card)) matureCards++
    }
  }

  // --- Review-log rollups (heatmap, streak, retention) ---
  const countsByDay = new Map<string, number>()
  let totalReviews = 0
  let correctReviews = 0
  for (const log of logs) {
    for (const g of log.grades) {
      const t = new Date(g.reviewedAt)
      if (Number.isNaN(t.getTime())) continue
      const key = localDateKey(t)
      countsByDay.set(key, (countsByDay.get(key) ?? 0) + 1)
      totalReviews++
      if (isCorrect(g.rating)) correctReviews++
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

  // --- Per-concept mastery (shared with the concept graph) ---
  const concepts = computeConceptMastery(decks, logs)

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
    concepts,
    calibration: computeCalibration(logs.flatMap((l) => l.grades))
  }
}
