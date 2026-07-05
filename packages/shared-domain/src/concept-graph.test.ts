import { describe, expect, it } from 'vitest'
import type { Flashcard, FlashcardDeck, ReviewGrade, ReviewLogFile, SrsState } from './flashcards'
import { FLASHCARD_STORE_VERSION, REVIEW_LOG_VERSION } from './flashcards'
import { MATURE_DAYS } from './study-stats'
import { buildConceptGraph, conceptKey, prerequisiteChain, WEAK_MASTERY_THRESHOLD } from './concept-graph'

// --- builders (mirror study-stats.test.ts) ---

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

function grade(cardId: string, rating: ReviewGrade['rating'] = 'good'): ReviewGrade {
  return { cardId, reviewedAt: '2026-06-25T09:00:00.000Z', predictedRating: rating, rating }
}

function log(notePath: string, grades: ReviewGrade[]): ReviewLogFile {
  return { version: REVIEW_LOG_VERSION, sourceNotePath: notePath, grades }
}

/** A card whose concept is fully mastered (stability well past MATURE_DAYS). */
function mastered(concept: string, over: Partial<Flashcard> = {}): Flashcard {
  return card({
    concepts: [concept],
    srs: srs({ state: 'review', stability: MATURE_DAYS * 2, due: '2026-07-01T00:00:00.000Z' }),
    ...over
  })
}

describe('buildConceptGraph', () => {
  it('makes a node per concept and an edge from prerequisite to focus concept', () => {
    const g = buildConceptGraph([deck('a.md', [card({ concepts: ['Trees'], prerequisites: ['Pointers'] })])], [])
    const keys = g.nodes.map((n) => n.key).sort()
    expect(keys).toEqual(['pointers', 'trees'])
    expect(g.edges).toEqual([{ from: 'pointers', to: 'trees' }])
    // Pointers has no card teaching it → orphan prerequisite node, total 0.
    const pointers = g.nodes.find((n) => n.key === 'pointers')!
    expect(pointers.total).toBe(0)
    expect(pointers.depth).toBe(0)
    expect(g.nodes.find((n) => n.key === 'trees')!.depth).toBe(1)
  })

  it('merges free-text concept label variants by normalized key', () => {
    const g = buildConceptGraph(
      [
        deck('a.md', [card({ concepts: ['Hash Maps'] })]),
        deck('b.md', [card({ concepts: ['  hash maps '] })])
      ],
      []
    )
    expect(g.nodes.filter((n) => n.key === conceptKey('hash maps'))).toHaveLength(1)
    const node = g.nodes.find((n) => n.key === 'hash maps')!
    expect(node.total).toBe(2)
    expect(node.notePaths.sort()).toEqual(['a.md', 'b.md'])
  })

  it('computes depth as the longest prerequisite chain', () => {
    // A -> B -> C  (A prereq of B, B prereq of C)
    const g = buildConceptGraph(
      [
        deck('n.md', [
          card({ concepts: ['B'], prerequisites: ['A'] }),
          card({ concepts: ['C'], prerequisites: ['B'] })
        ])
      ],
      []
    )
    const depthOf = (k: string): number => g.nodes.find((n) => n.key === k)!.depth
    expect(depthOf('a')).toBe(0)
    expect(depthOf('b')).toBe(1)
    expect(depthOf('c')).toBe(2)
    expect(g.hasCycle).toBe(false)
  })

  it('breaks back-edges on a cycle and flags hasCycle', () => {
    const g = buildConceptGraph(
      [
        deck('n.md', [
          card({ concepts: ['A'], prerequisites: ['B'] }),
          card({ concepts: ['B'], prerequisites: ['A'] })
        ])
      ],
      []
    )
    expect(g.hasCycle).toBe(true)
    // Depth still resolves finitely for both nodes.
    for (const n of g.nodes) expect(Number.isFinite(n.depth)).toBe(true)
  })

  it('ranks gaps: unmet-prereq before orphan-prereq before plain weak', () => {
    const g = buildConceptGraph(
      [
        deck('n.md', [
          // Weak foundation that something depends on → unmet-prereq.
          card({ concepts: ['Weak Foundation'], prerequisites: [] }),
          card({ concepts: ['Advanced'], prerequisites: ['Weak Foundation', 'Never Taught'] }),
          // A weak leaf nothing depends on → plain weak.
          card({ concepts: ['Lonely'], prerequisites: [] }),
          // A fully mastered concept → not a gap.
          mastered('Solid')
        ])
      ],
      []
    )
    const reasons = Object.fromEntries(g.gaps.map((x) => [x.key, x.reason]))
    expect(reasons['weak foundation']).toBe('unmet-prereq')
    expect(reasons['never taught']).toBe('orphan-prereq')
    expect(reasons['lonely']).toBe('weak')
    expect(reasons['solid']).toBeUndefined()
    // Ordering: unmet-prereq first.
    expect(g.gaps[0].reason).toBe('unmet-prereq')
    // Mastered concept is not flagged.
    expect(g.nodes.find((n) => n.key === 'solid')!.isGap).toBe(false)
  })

  it('does not flag a mastered concept even if it has dependents', () => {
    const g = buildConceptGraph(
      [
        deck('n.md', [
          mastered('Basics'),
          card({ concepts: ['Builds On Basics'], prerequisites: ['Basics'] })
        ])
      ],
      []
    )
    expect(g.nodes.find((n) => n.key === 'basics')!.isGap).toBe(false)
  })

  it('keeps prerequisite edges distinct when concept labels contain spaces', () => {
    // A naive `${from} ${to}` dedup key would collapse these two distinct edges.
    const g = buildConceptGraph(
      [
        deck('n.md', [
          card({ concepts: ['c'], prerequisites: ['a b'] }),
          card({ concepts: ['b c'], prerequisites: ['a'] })
        ])
      ],
      []
    )
    expect(g.edges).toContainEqual({ from: 'a b', to: 'c' })
    expect(g.edges).toContainEqual({ from: 'a', to: 'b c' })
    expect(g.edges).toHaveLength(2)
  })

  it('uses review history for concept accuracy', () => {
    const c = card({ id: 'g1', concepts: ['Graphs'] })
    const g = buildConceptGraph(
      [deck('n.md', [c])],
      [log('n.md', [grade('g1', 'good'), grade('g1', 'again')])]
    )
    expect(g.nodes.find((n) => n.key === 'graphs')!.accuracy).toBeCloseTo(0.5)
  })

  it('weak threshold boundary: at/above the threshold is not weak', () => {
    // Build a concept whose masteryPct lands exactly at the threshold.
    const stability = (WEAK_MASTERY_THRESHOLD / 100) * MATURE_DAYS
    const g = buildConceptGraph(
      [deck('n.md', [card({ concepts: ['Edge'], srs: srs({ state: 'review', stability }) })])],
      []
    )
    expect(g.nodes.find((n) => n.key === 'edge')!.isGap).toBe(false)
  })
})

describe('prerequisiteChain', () => {
  it('returns the target plus transitive prerequisites, foundational-first', () => {
    // A -> B -> C (study C, but A and B come first, in depth order).
    const g = buildConceptGraph(
      [
        deck('n.md', [
          card({ concepts: ['B'], prerequisites: ['A'] }),
          card({ concepts: ['C'], prerequisites: ['B'] })
        ])
      ],
      []
    )
    expect(prerequisiteChain(g, 'C')).toEqual(['a', 'b', 'c'])
    // A standalone concept with no prerequisites is just itself.
    expect(prerequisiteChain(g, 'A')).toEqual(['a'])
  })

  it('matches the target by normalized key and ignores unknown concepts', () => {
    const g = buildConceptGraph([deck('n.md', [card({ concepts: ['Trees'], prerequisites: ['Pointers'] })])], [])
    expect(prerequisiteChain(g, '  TREES ')).toEqual(['pointers', 'trees'])
    expect(prerequisiteChain(g, 'Nonexistent')).toEqual(['nonexistent'])
    expect(prerequisiteChain(g, '   ')).toEqual([])
  })

  it('tolerates cycles without looping forever', () => {
    const g = buildConceptGraph(
      [
        deck('n.md', [
          card({ concepts: ['A'], prerequisites: ['B'] }),
          card({ concepts: ['B'], prerequisites: ['A'] })
        ])
      ],
      []
    )
    expect(prerequisiteChain(g, 'A').sort()).toEqual(['a', 'b'])
  })
})
