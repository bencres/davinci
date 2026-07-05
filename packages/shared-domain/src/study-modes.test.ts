import { describe, expect, it } from 'vitest'
import type { Flashcard, FsrsRating, ReviewGrade, ReviewLogFile, SrsState } from './flashcards'
import { REVIEW_LOG_VERSION } from './flashcards'
import type { CardIndex } from './srs'
import { rankWeakCards, selectMiscalibratedCards, selectRecentMisses } from './study-modes'

function srs(over: Partial<SrsState> = {}): SrsState {
  return {
    state: 'review',
    due: '2026-06-20T00:00:00.000Z',
    stability: 10,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    lastReview: '2026-06-10T00:00:00.000Z',
    ...over
  }
}

function card(id: string, over: Partial<SrsState> = {}): Flashcard {
  return {
    id,
    kind: 'recall',
    subtype: 'cued',
    front: 'q',
    back: 'a',
    concepts: ['c'],
    prerequisites: [],
    difficulty: 2,
    srs: srs(over),
    userEdited: false,
    createdAt: 0,
    generatedBy: 'test'
  }
}

function index(cards: Flashcard[]): CardIndex {
  const out: CardIndex = {}
  for (const c of cards) out[c.id] = { card: c, sourceNotePath: 'n.md' }
  return out
}

function grade(
  cardId: string,
  rating: FsrsRating,
  // `predictedRating: null` builds a grade where the learner skipped predicting.
  over: { predictedRating?: FsrsRating | null; reviewedAt?: string } = {}
): ReviewGrade {
  return {
    cardId,
    reviewedAt: over.reviewedAt ?? '2026-06-25T09:00:00.000Z',
    ...(over.predictedRating === null ? {} : { predictedRating: over.predictedRating ?? rating }),
    rating
  }
}

function log(grades: ReviewGrade[]): ReviewLogFile[] {
  return [{ version: REVIEW_LOG_VERSION, sourceNotePath: 'n.md', grades }]
}

describe('rankWeakCards', () => {
  it('orders by accuracy asc, then lapses desc, then stability asc', () => {
    const idx = index([
      card('high', { lapses: 0, stability: 20 }), // accuracy 1.0
      card('low', { lapses: 1, stability: 5 }), // accuracy 0.0
      card('mid', { lapses: 0, stability: 5 }) // accuracy 0.5
    ])
    const logs = log([
      grade('high', 'good'),
      grade('low', 'again'),
      grade('mid', 'good'),
      grade('mid', 'again')
    ])
    expect(rankWeakCards(idx, logs)).toEqual(['low', 'mid', 'high'])
  })

  it('excludes never-reviewed cards and honors the limit', () => {
    const idx = index([card('seen'), card('unseen')])
    const logs = log([grade('seen', 'hard')])
    expect(rankWeakCards(idx, logs)).toEqual(['seen'])
    expect(rankWeakCards(idx, logs, { limit: 0 })).toEqual([])
  })

  it('breaks ties on lapses then stability then id', () => {
    const idx = index([
      card('b', { lapses: 2, stability: 5 }),
      card('a', { lapses: 2, stability: 5 })
    ])
    // both accuracy 0 → equal lapses+stability → id asc
    const logs = log([grade('a', 'again'), grade('b', 'again')])
    expect(rankWeakCards(idx, logs)).toEqual(['a', 'b'])
  })
})

describe('selectRecentMisses', () => {
  const NOW = new Date('2026-06-25T20:00:00.000Z')

  it('returns cards missed today, most-recent miss first', () => {
    const idx = index([card('x'), card('y'), card('z')])
    const logs = log([
      grade('x', 'again', { reviewedAt: '2026-06-25T08:00:00.000Z' }),
      grade('y', 'hard', { reviewedAt: '2026-06-25T18:00:00.000Z' }),
      grade('z', 'good', { reviewedAt: '2026-06-25T10:00:00.000Z' }) // not a miss
    ])
    expect(selectRecentMisses(idx, logs, { now: NOW })).toEqual(['y', 'x'])
  })

  it('excludes misses outside the window (older than today by default)', () => {
    const idx = index([card('x')])
    const logs = log([grade('x', 'again', { reviewedAt: '2026-06-24T23:00:00.000Z' })])
    expect(selectRecentMisses(idx, logs, { now: NOW })).toEqual([])
    // A wider explicit window picks it back up.
    expect(selectRecentMisses(idx, logs, { now: NOW, withinMs: 48 * 3600_000 })).toEqual(['x'])
  })

  it('uses a card’s latest miss for ordering and honors the limit', () => {
    const idx = index([card('x'), card('y')])
    const logs = log([
      grade('x', 'again', { reviewedAt: '2026-06-25T07:00:00.000Z' }),
      grade('x', 'hard', { reviewedAt: '2026-06-25T19:00:00.000Z' }), // x's latest miss
      grade('y', 'again', { reviewedAt: '2026-06-25T12:00:00.000Z' })
    ])
    expect(selectRecentMisses(idx, logs, { now: NOW })).toEqual(['x', 'y'])
    expect(selectRecentMisses(idx, logs, { now: NOW, limit: 1 })).toEqual(['x'])
  })
})

describe('selectMiscalibratedCards', () => {
  it('keeps cards above the error threshold, worst first', () => {
    const idx = index([card('big'), card('small'), card('none')])
    const logs = log([
      grade('big', 'again', { predictedRating: 'easy' }), // |1-4| = 3
      grade('small', 'good', { predictedRating: 'hard' }), // |3-2| = 1
      grade('none', 'good', { predictedRating: 'good' }) // 0 — well calibrated
    ])
    expect(selectMiscalibratedCards(idx, logs)).toEqual(['big', 'small'])
    expect(selectMiscalibratedCards(idx, logs, { threshold: 2 })).toEqual(['big'])
  })

  it('averages error across a card’s grades', () => {
    const idx = index([card('x')])
    const logs = log([
      grade('x', 'again', { predictedRating: 'easy' }), // 3
      grade('x', 'good', { predictedRating: 'good' }) // 0 → mean 1.5
    ])
    expect(selectMiscalibratedCards(idx, logs, { threshold: 1.5 })).toEqual(['x'])
    expect(selectMiscalibratedCards(idx, logs, { threshold: 1.6 })).toEqual([])
  })

  it('ignores grades where the learner skipped the prediction', () => {
    const idx = index([card('x'), card('y')])
    const logs = log([
      // Skipped predictions must not dilute the mean toward "well calibrated"…
      grade('x', 'again', { predictedRating: null }),
      grade('x', 'again', { predictedRating: 'easy' }), // 3 → mean stays 3
      // …and a card with only skipped predictions has no calibration signal at all.
      grade('y', 'again', { predictedRating: null })
    ])
    expect(selectMiscalibratedCards(idx, logs, { threshold: 3 })).toEqual(['x'])
  })
})
