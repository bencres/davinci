import { describe, expect, it } from 'vitest'
import type { Flashcard, FlashcardDeck, ReviewGrade, ReviewLogFile, SrsState } from './flashcards'
import { FLASHCARD_STORE_VERSION, REVIEW_LOG_VERSION } from './flashcards'
import {
  computeCurrentStreak,
  computeLongestStreak,
  computeStudyStats,
  DEFAULT_STUDY_GAMIFICATION,
  HEATMAP_DAYS,
  localDateKey,
  MATURE_DAYS,
  normalizeGamification,
  type StudyGamification
} from './study-stats'

// --- builders ---

function srs(over: Partial<SrsState> = {}): SrsState {
  return {
    state: 'new',
    due: null,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    lastReview: null,
    ...over
  }
}

let cardCounter = 0
function card(over: Partial<Flashcard> = {}): Flashcard {
  cardCounter++
  return {
    id: `c${cardCounter}`,
    kind: 'recall',
    subtype: 'cued',
    front: 'Q',
    back: 'A',
    concepts: ['X'],
    prerequisites: [],
    difficulty: 2,
    srs: srs(),
    userEdited: false,
    createdAt: cardCounter,
    generatedBy: 'test',
    ...over
  }
}

function deck(notePath: string, cards: Flashcard[]): FlashcardDeck {
  return { version: FLASHCARD_STORE_VERSION, sourceNotePath: notePath, cards }
}

function grade(cardId: string, reviewedAt: string, rating: ReviewGrade['rating'] = 'good'): ReviewGrade {
  return { cardId, reviewedAt, predictedRating: rating, rating }
}

function log(notePath: string, grades: ReviewGrade[]): ReviewLogFile {
  return { version: REVIEW_LOG_VERSION, sourceNotePath: notePath, grades }
}

/** Local-midnight ISO for `daysAgo` days before `now`. */
function dayAgoIso(now: Date, daysAgo: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 9, 0, 0)
  return d.toISOString()
}

const NOW = new Date(2026, 5, 25, 12, 0, 0) // 2026-06-25 noon local

describe('normalizeGamification', () => {
  it('defaults on missing / invalid input', () => {
    expect(normalizeGamification(null)).toEqual(DEFAULT_STUDY_GAMIFICATION)
    expect(normalizeGamification({ dailyGoal: 0 }).dailyGoal).toBe(DEFAULT_STUDY_GAMIFICATION.dailyGoal)
    expect(normalizeGamification({ dailyGoal: 'x' }).dailyGoal).toBe(DEFAULT_STUDY_GAMIFICATION.dailyGoal)
  })
  it('keeps valid values', () => {
    const g = normalizeGamification({ dailyGoal: 35, streakFreezes: 2, freezeUsedDates: ['2026-06-01', 5] })
    expect(g.dailyGoal).toBe(35)
    expect(g.streakFreezes).toBe(2)
    expect(g.freezeUsedDates).toEqual(['2026-06-01'])
  })
})

describe('computeCurrentStreak', () => {
  const freeze = new Set<string>()
  it('is 0 when nothing studied', () => {
    expect(computeCurrentStreak(new Set(), freeze, NOW)).toBe(0)
  })
  it('counts consecutive days ending today', () => {
    const active = new Set([localDateKey(NOW), '2026-06-24', '2026-06-23'])
    expect(computeCurrentStreak(active, freeze, NOW)).toBe(3)
  })
  it('does not break when today has no reviews yet (counts from yesterday)', () => {
    const active = new Set(['2026-06-24', '2026-06-23'])
    expect(computeCurrentStreak(active, freeze, NOW)).toBe(2)
  })
  it('breaks on a real gap', () => {
    const active = new Set([localDateKey(NOW), '2026-06-22']) // missed the 23rd & 24th
    expect(computeCurrentStreak(active, freeze, NOW)).toBe(1)
  })
  it('bridges a gap covered by a freeze', () => {
    const active = new Set([localDateKey(NOW), '2026-06-23']) // missed the 24th
    const frozen = new Set(['2026-06-24'])
    expect(computeCurrentStreak(active, frozen, NOW)).toBe(2)
  })
})

describe('computeLongestStreak', () => {
  it('finds the longest run, ignoring current position', () => {
    const active = new Set(['2026-01-01', '2026-01-02', '2026-01-03', '2026-03-10'])
    expect(computeLongestStreak(active, new Set())).toBe(3)
  })
  it('bridges runs across a freeze day', () => {
    const active = new Set(['2026-01-01', '2026-01-03'])
    const frozen = new Set(['2026-01-02'])
    expect(computeLongestStreak(active, frozen)).toBe(2)
  })
})

describe('computeStudyStats', () => {
  it('returns zeros for an empty vault', () => {
    const stats = computeStudyStats([], [], DEFAULT_STUDY_GAMIFICATION, NOW)
    expect(stats.totalCards).toBe(0)
    expect(stats.currentStreak).toBe(0)
    expect(stats.retentionRate).toBe(0)
    expect(stats.concepts).toEqual([])
    expect(stats.heatmap).toHaveLength(HEATMAP_DAYS)
    expect(stats.heatmap.every((d) => d.count === 0)).toBe(true)
    expect(stats.heatmap[stats.heatmap.length - 1].date).toBe(localDateKey(NOW))
  })

  it('classifies cards into due / new / mature', () => {
    const newCard = card({ srs: srs() })
    const dueCard = card({
      srs: srs({ state: 'review', due: dayAgoIso(NOW, 1), stability: 5, reps: 2 })
    })
    const matureCard = card({
      srs: srs({ state: 'review', due: dayAgoIso(NOW, -10), stability: MATURE_DAYS + 5, reps: 9 })
    })
    const stats = computeStudyStats([deck('a.md', [newCard, dueCard, matureCard])], [], DEFAULT_STUDY_GAMIFICATION, NOW)
    expect(stats.totalCards).toBe(3)
    expect(stats.newAvailable).toBe(1)
    expect(stats.dueToday).toBe(1)
    expect(stats.matureCards).toBe(1)
  })

  it('computes today reviews, goal-met and retention from logs', () => {
    const c1 = card()
    const c2 = card()
    const grades = [
      grade(c1.id, dayAgoIso(NOW, 0), 'good'),
      grade(c2.id, dayAgoIso(NOW, 0), 'again'),
      grade(c1.id, dayAgoIso(NOW, 1), 'easy')
    ]
    const gam: StudyGamification = { ...DEFAULT_STUDY_GAMIFICATION, dailyGoal: 2 }
    const stats = computeStudyStats([deck('a.md', [c1, c2])], [log('a.md', grades)], gam, NOW)
    expect(stats.reviewsToday).toBe(2)
    expect(stats.goalMet).toBe(true)
    expect(stats.totalReviews).toBe(3)
    expect(stats.retentionRate).toBeCloseTo(2 / 3, 5)
  })

  it('buckets heatmap counts by local day', () => {
    const c1 = card()
    const grades = [
      grade(c1.id, dayAgoIso(NOW, 0)),
      grade(c1.id, dayAgoIso(NOW, 0)),
      grade(c1.id, dayAgoIso(NOW, 2))
    ]
    const stats = computeStudyStats([deck('a.md', [c1])], [log('a.md', grades)], DEFAULT_STUDY_GAMIFICATION, NOW)
    const byDate = new Map(stats.heatmap.map((d) => [d.date, d.count]))
    expect(byDate.get(localDateKey(NOW))).toBe(2)
    expect(byDate.get('2026-06-23')).toBe(1)
    expect(byDate.get('2026-06-24')).toBe(0)
  })

  it('aggregates per-concept mastery, accuracy and notes', () => {
    const c1 = card({ concepts: ['Trees', 'Graphs'], srs: srs({ state: 'review', stability: MATURE_DAYS, due: dayAgoIso(NOW, -1) }) })
    const c2 = card({ concepts: ['Trees'], srs: srs() }) // new → 0 mastery
    const grades = [grade(c1.id, dayAgoIso(NOW, 0), 'good'), grade(c1.id, dayAgoIso(NOW, 1), 'again')]
    const stats = computeStudyStats([deck('a.md', [c1, c2])], [log('a.md', grades)], DEFAULT_STUDY_GAMIFICATION, NOW)
    const trees = stats.concepts.find((c) => c.concept === 'Trees')!
    expect(trees.total).toBe(2)
    expect(trees.mature).toBe(1)
    expect(trees.accuracy).toBeCloseTo(0.5, 5) // 1 good of 2 graded (both grades are c1, tagged Trees)
    expect(trees.masteryPct).toBe(50) // (1.0 + 0) / 2
    expect(trees.notePaths).toEqual(['a.md'])
    // Sorted by total desc → Trees (2) before Graphs (1)
    expect(stats.concepts[0].concept).toBe('Trees')
  })
})
