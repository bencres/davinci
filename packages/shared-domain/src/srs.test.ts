import { describe, expect, it } from 'vitest'
import type { Flashcard, SrsState } from './flashcards'
import { newSrsState } from './flashcards'
import {
  fsrsCardToSrs,
  isDue,
  isNew,
  selectDueQueue,
  selectFreeQueue,
  selectNewQueue,
  shapeSession,
  splitNewVsReview,
  srsToFsrsCard,
  type CardIndex
} from './srs'

const ISO = (s: string) => new Date(s).toISOString()
const NOW = new Date('2026-06-25T12:00:00.000Z')

/** Minimal Flashcard for queue tests — only `srs` + `createdAt` are read. */
function card(id: string, srs: SrsState, createdAt = 0): Flashcard {
  return {
    id,
    kind: 'recall',
    subtype: 'cued',
    front: 'q',
    back: 'a',
    concepts: ['c'],
    prerequisites: [],
    difficulty: 2,
    srs,
    userEdited: false,
    createdAt,
    generatedBy: 'test'
  }
}

function reviewSrs(over: Partial<SrsState> = {}): SrsState {
  return {
    state: 'review',
    due: ISO('2026-06-20T00:00:00.000Z'),
    stability: 10,
    difficulty: 5,
    reps: 3,
    lapses: 1,
    lastReview: ISO('2026-06-10T00:00:00.000Z'),
    ...over
  }
}

function index(cards: Flashcard[]): CardIndex {
  const out: CardIndex = {}
  for (const c of cards) out[c.id] = { card: c, sourceNotePath: `${c.id}.md` }
  return out
}

describe('SrsState ⇄ ts-fsrs card conversion', () => {
  it('maps a never-scheduled card to a fresh New card due now', () => {
    const fsrs = srsToFsrsCard(newSrsState(), NOW)
    expect(fsrs.state).toBe('New')
    expect(fsrs.due).toBe(NOW.toISOString())
    expect(fsrs.stability).toBe(0)
    expect(fsrs.reps).toBe(0)
    expect(fsrs.last_review).toBeUndefined()
  })

  it('round-trips a scheduled review card', () => {
    const srs = reviewSrs()
    const fsrs = srsToFsrsCard(srs, NOW)
    expect(fsrs.state).toBe('Review')
    expect(fsrs.due).toBe(srs.due)
    expect(fsrs.stability).toBe(10)
    expect(fsrs.last_review).toBe(srs.lastReview)

    const back = fsrsCardToSrs(
      { due: new Date(srs.due!), stability: 10, difficulty: 5, reps: 3, lapses: 1, state: 2, last_review: new Date(srs.lastReview!) },
      NOW
    )
    expect(back).toEqual(srs)
  })

  it('reads back numeric and string FSRS states and Date dues', () => {
    const back = fsrsCardToSrs(
      { due: NOW, stability: 1, difficulty: 2, reps: 1, lapses: 0, state: 'Relearning' },
      NOW
    )
    expect(back.state).toBe('relearning')
    expect(back.due).toBe(NOW.toISOString())
    expect(back.lastReview).toBe(NOW.toISOString()) // falls back to now when omitted
  })
})

describe('isNew / isDue', () => {
  it('classifies new vs due vs not-yet-due', () => {
    const nowMs = NOW.getTime()
    expect(isNew(newSrsState())).toBe(true)
    expect(isDue(newSrsState(), nowMs)).toBe(false)
    expect(isDue(reviewSrs({ due: ISO('2026-06-20T00:00:00.000Z') }), nowMs)).toBe(true)
    expect(isDue(reviewSrs({ due: ISO('2026-06-30T00:00:00.000Z') }), nowMs)).toBe(false)
  })
})

describe('selectDueQueue', () => {
  it('orders learning-due, then due reviews, then new; deterministic', () => {
    const cards = [
      card('new-b', newSrsState(), 200),
      card('new-a', newSrsState(), 100),
      card('rev-late', reviewSrs({ due: ISO('2026-06-22T00:00:00.000Z') }), 0),
      card('rev-early', reviewSrs({ due: ISO('2026-06-18T00:00:00.000Z') }), 0),
      card('learn', reviewSrs({ state: 'learning', due: ISO('2026-06-25T09:00:00.000Z') }), 0),
      card('future', reviewSrs({ due: ISO('2026-07-01T00:00:00.000Z') }), 0)
    ]
    const q = selectDueQueue(index(cards), { now: NOW })
    expect(q).toEqual(['learn', 'rev-early', 'rev-late', 'new-a', 'new-b'])
  })

  it('caps new cards by newPerDay minus newDoneToday', () => {
    const cards = [
      card('n1', newSrsState(), 1),
      card('n2', newSrsState(), 2),
      card('n3', newSrsState(), 3)
    ]
    expect(selectDueQueue(index(cards), { now: NOW, newPerDay: 2 })).toEqual(['n1', 'n2'])
    expect(selectDueQueue(index(cards), { now: NOW, newPerDay: 2, newDoneToday: 1 })).toEqual(['n1'])
    expect(selectDueQueue(index(cards), { now: NOW, newPerDay: 2, newDoneToday: 5 })).toEqual([])
  })

  it('ignores due dates and includes every card, even when nothing is due', () => {
    const cards = [
      card('future', reviewSrs({ due: ISO('2026-07-01T00:00:00.000Z') }), 0),
      card('also-future', reviewSrs({ due: ISO('2026-08-01T00:00:00.000Z') }), 0)
    ]
    // selectDueQueue would be empty here; free study still yields both cards.
    expect(selectDueQueue(index(cards), { now: NOW })).toEqual([])
    expect(selectFreeQueue(index(cards))).toEqual(['also-future', 'future'])
  })

  it('shuffles deterministically with an injected rng and applies a limit', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => card(id, reviewSrs()))
    // rng always returns 0 → Fisher–Yates swaps each i with index 0.
    const q = selectFreeQueue(index(cards), { shuffle: true, rng: () => 0 })
    expect([...q].sort()).toEqual(['a', 'b', 'c', 'd']) // same set, reordered
    expect(q).toEqual(['b', 'c', 'd', 'a'])
    expect(selectFreeQueue(index(cards), { shuffle: true, rng: () => 0, limit: 2 })).toEqual(['b', 'c'])
  })

  it('caps due reviews but never learning-due cards', () => {
    const cards = [
      card('r1', reviewSrs({ due: ISO('2026-06-18T00:00:00.000Z') }), 0),
      card('r2', reviewSrs({ due: ISO('2026-06-19T00:00:00.000Z') }), 0),
      card('l1', reviewSrs({ state: 'relearning', due: ISO('2026-06-25T08:00:00.000Z') }), 0)
    ]
    const q = selectDueQueue(index(cards), { now: NOW, maxReviewsPerDay: 1 })
    expect(q).toEqual(['l1', 'r1']) // relearning always in; reviews capped to 1
  })
})

describe('selectNewQueue', () => {
  it('returns only new cards, oldest-authored first, ignoring the daily cap', () => {
    const cards = [
      card('new-b', newSrsState(), 200),
      card('new-a', newSrsState(), 100),
      card('rev', reviewSrs({ due: ISO('2026-06-18T00:00:00.000Z') }), 0),
      card('new-c', newSrsState(), 300)
    ]
    expect(selectNewQueue(index(cards))).toEqual(['new-a', 'new-b', 'new-c'])
    expect(selectNewQueue(index(cards), { limit: 2 })).toEqual(['new-a', 'new-b'])
  })
})

describe('shapeSession', () => {
  /** Flashcard with controllable difficulty / concept / srs state for shaping. */
  function mk(
    id: string,
    opts: { difficulty?: 1 | 2 | 3 | 4; concepts?: string[]; state?: SrsState['state']; stability?: number } = {}
  ): Flashcard {
    return {
      ...card(id, reviewSrs({ state: opts.state ?? 'review', stability: opts.stability ?? 10 })),
      concepts: opts.concepts ?? ['c'],
      difficulty: opts.difficulty ?? 2
    }
  }

  it('sandwiches: easy warm-up first, hardest in the middle, easy cool-down last', () => {
    // Same concept everywhere so interleaving is a no-op and order is exact.
    const cards = [
      mk('a', { difficulty: 4 }),
      mk('b', { difficulty: 4 }),
      mk('c', { difficulty: 1 }),
      mk('d', { difficulty: 1 }),
      mk('e', { difficulty: 2 }),
      mk('f', { difficulty: 3 })
    ]
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const out = shapeSession(ids, index(cards))
    expect(out).toEqual(['c', 'd', 'a', 'b', 'e', 'f'])
    // warm-up = the two easiest, cool-down = next easiest, middle = hardest.
    expect(out.slice(0, 2)).toEqual(['c', 'd'])
    expect(out.slice(-2)).toEqual(['e', 'f'])
    expect([...out].sort()).toEqual([...ids].sort()) // permutation
  })

  it('keeps due learning/relearning cards first', () => {
    const cards = [
      mk('L', { state: 'learning', difficulty: 4 }),
      mk('a', { difficulty: 1 }),
      mk('b', { difficulty: 1 }),
      mk('c', { difficulty: 2 }),
      mk('d', { difficulty: 3 }),
      mk('e', { difficulty: 3 }),
      mk('f', { difficulty: 4 })
    ]
    const out = shapeSession(['L', 'a', 'b', 'c', 'd', 'e', 'f'], index(cards))
    expect(out[0]).toBe('L')
  })

  it('interleaves so consecutive cards avoid the same focus concept', () => {
    const cards = [
      mk('x1', { concepts: ['X'] }),
      mk('x2', { concepts: ['X'] }),
      mk('y1', { concepts: ['Y'] }),
      mk('y2', { concepts: ['Y'] })
    ]
    const out = shapeSession(['x1', 'x2', 'y1', 'y2'], index(cards), { warmupCount: 0, cooldownCount: 0 })
    const conceptOf = (id: string): string => cards.find((c) => c.id === id)!.concepts[0]
    for (let i = 0; i < out.length - 1; i++) {
      expect(conceptOf(out[i])).not.toBe(conceptOf(out[i + 1]))
    }
  })

  it('leaves a too-small queue as a permutation (no sandwich)', () => {
    const cards = [mk('a'), mk('b'), mk('c')]
    const out = shapeSession(['a', 'b', 'c'], index(cards))
    expect([...out].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('splitNewVsReview', () => {
  it('separates never-scheduled from due ids', () => {
    const cards = [
      card('n', newSrsState()),
      card('d', reviewSrs({ due: ISO('2026-06-20T00:00:00.000Z') })),
      card('f', reviewSrs({ due: ISO('2026-07-20T00:00:00.000Z') }))
    ]
    const { newIds, dueIds } = splitNewVsReview(index(cards), NOW)
    expect(newIds).toEqual(['n'])
    expect(dueIds).toEqual(['d'])
  })
})
