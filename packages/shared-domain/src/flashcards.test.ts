import { describe, expect, it } from 'vitest'
import {
  buildCardIndex,
  checkRecallAnswer,
  deckPathForNote,
  difficultyLabel,
  findSourceQuoteOffset,
  draftToCard,
  emptyDeck,
  flashcardsTabPath,
  flashcardsTitleFromTab,
  isFlashcardInternalPath,
  isFlashcardsTabPath,
  notePathFromDeckPath,
  notePathFromFlashcardsTab,
  normalizeDraft,
  relocateDeckPath,
  scoreRubric,
  scoreToRating,
  type FlashcardDraft,
  type Rubric
} from './flashcards'

// Deterministic id factory for tests (mirror database-csv tests).
function counterId(): () => string {
  let n = 0
  return () => `id-${++n}`
}

const validRubric = (): Rubric => ({
  criteria: [
    { id: 'k1', description: 'Names the mechanism', weight: 2 },
    { id: 'k2', description: 'Gives a concrete example', weight: 1 }
  ],
  modelAnswer: 'A full-credit answer.',
  misconceptions: ['Confuses cause with correlation']
})

const recallDraft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'recall',
  subtype: 'cued',
  front: 'What is X?',
  back: 'X is a thing.',
  concepts: ['X'],
  prerequisites: ['Y'],
  difficulty: 2,
  ...over
})

const synthesisDraft = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'synthesis',
  subtype: 'application',
  front: 'Apply X to a new case.',
  back: 'You would...',
  concepts: ['X'],
  prerequisites: [],
  difficulty: 4,
  rubric: validRubric(),
  ...over
})

describe('deck + tab path helpers', () => {
  it('round-trips note path ⇄ deck path', () => {
    expect(deckPathForNote('a/Note.md')).toBe('.zennotes/flashcards/a/Note.md.cards.json')
    expect(notePathFromDeckPath('.zennotes/flashcards/a/Note.md.cards.json')).toBe('a/Note.md')
    expect(notePathFromDeckPath('a/Note.md')).toBeNull()
    // Leading slashes are normalized away.
    expect(deckPathForNote('/a/Note.md')).toBe('.zennotes/flashcards/a/Note.md.cards.json')
  })

  it('round-trips note path ⇄ tab path and derives a title', () => {
    const tab = flashcardsTabPath('inbox/My Note.md')
    expect(isFlashcardsTabPath(tab)).toBe(true)
    expect(isFlashcardsTabPath('zen://database/x')).toBe(false)
    expect(notePathFromFlashcardsTab(tab)).toBe('inbox/My Note.md')
    expect(flashcardsTitleFromTab(tab)).toBe('My Note')
  })

  it('flags deck files as internal app paths', () => {
    expect(isFlashcardInternalPath('.zennotes/flashcards/a/Note.md.cards.json')).toBe(true)
    expect(isFlashcardInternalPath('.zennotes/flashcards')).toBe(true)
    expect(isFlashcardInternalPath('a/Note.md')).toBe(false)
  })

  it('computes relocation paths for a rename/move', () => {
    expect(relocateDeckPath('a/Old.md', 'b/New.md')).toEqual({
      from: '.zennotes/flashcards/a/Old.md.cards.json',
      to: '.zennotes/flashcards/b/New.md.cards.json'
    })
  })
})

describe('normalizeDraft', () => {
  it('accepts a well-formed recall card', () => {
    const d = normalizeDraft(recallDraft())
    expect(d?.kind).toBe('recall')
    expect(d?.subtype).toBe('cued')
    expect(d?.rubric).toBeUndefined()
  })

  it('accepts a well-formed synthesis card and keeps its rubric', () => {
    const d = normalizeDraft(synthesisDraft())
    expect(d?.kind).toBe('synthesis')
    expect(d?.rubric?.criteria).toHaveLength(2)
    expect(d?.rubric?.modelAnswer).toBe('A full-credit answer.')
  })

  it('drops cards with empty front/back or no concepts', () => {
    expect(normalizeDraft(recallDraft({ front: '   ' }))).toBeNull()
    expect(normalizeDraft(recallDraft({ back: '' }))).toBeNull()
    expect(normalizeDraft(recallDraft({ concepts: [] }))).toBeNull()
    expect(normalizeDraft(recallDraft({ concepts: ['', '  '] }))).toBeNull()
  })

  it('rejects a subtype that does not match its kind', () => {
    expect(normalizeDraft(recallDraft({ subtype: 'application' }))).toBeNull()
    expect(normalizeDraft(synthesisDraft({ subtype: 'cued' }))).toBeNull()
    expect(normalizeDraft(recallDraft({ subtype: 'bogus' }))).toBeNull()
  })

  it('clamps concepts and prerequisites to 1–3, deduped', () => {
    const d = normalizeDraft(
      recallDraft({ concepts: ['a', 'a', 'b', 'c', 'd'], prerequisites: ['p', 'p', 'q', 'r', 's'] })
    )
    expect(d?.concepts).toEqual(['a', 'b', 'c'])
    expect(d?.prerequisites).toEqual(['p', 'q', 'r'])
  })

  it('clamps difficulty into 1–4 and defaults to Moderate when invalid', () => {
    expect(normalizeDraft(recallDraft({ difficulty: 9 }))?.difficulty).toBe(4)
    expect(normalizeDraft(recallDraft({ difficulty: 0 }))?.difficulty).toBe(1)
    expect(normalizeDraft(recallDraft({ difficulty: 'x' }))?.difficulty).toBe(2)
  })

  it('enforces the grading contract', () => {
    // synthesis without a valid rubric is dropped
    expect(normalizeDraft(synthesisDraft({ rubric: undefined }))).toBeNull()
    expect(normalizeDraft(synthesisDraft({ rubric: { criteria: [], modelAnswer: 'x' } }))).toBeNull()
    expect(
      normalizeDraft(
        synthesisDraft({ rubric: { criteria: [{ description: 'd', weight: 1 }], modelAnswer: '' } })
      )
    ).toBeNull()
    // recall must not carry a rubric (stripped)
    expect(normalizeDraft(recallDraft({ rubric: validRubric() }))?.rubric).toBeUndefined()
  })

  it('mints rubric criterion ids when missing', () => {
    const d = normalizeDraft(
      synthesisDraft({ rubric: { criteria: [{ description: 'd', weight: 2 }], modelAnswer: 'm' } }),
      counterId()
    )
    expect(d?.rubric?.criteria[0]?.id).toBe('id-1')
  })

  it('normalizes and dedupes acceptableAnswers on recall cards', () => {
    const d = normalizeDraft(recallDraft({ subtype: 'cloze', acceptableAnswers: ['A', 'A', ' b ', ''] }))
    expect(d?.acceptableAnswers).toEqual(['A', 'b'])
  })
})

describe('draftToCard', () => {
  it('mints identity + initializes srs as new', () => {
    const draft = normalizeDraft(recallDraft()) as FlashcardDraft
    const card = draftToCard(draft, 'claude-sonnet-4-6', { genId: counterId(), now: 123, userEdited: true })
    expect(card.id).toBe('id-1')
    expect(card.generatedBy).toBe('claude-sonnet-4-6')
    expect(card.userEdited).toBe(true)
    expect(card.createdAt).toBe(123)
    expect(card.srs).toEqual({
      state: 'new',
      due: null,
      stability: null,
      difficulty: null,
      reps: 0,
      lapses: 0,
      lastReview: null
    })
  })
})

describe('buildCardIndex', () => {
  it('maps cardId → card + sourceNotePath across decks', () => {
    const deckA = emptyDeck('a.md')
    deckA.cards = [draftToCard(normalizeDraft(recallDraft()) as FlashcardDraft, 'm', { genId: () => 'c1' })]
    const deckB = emptyDeck('b.md')
    deckB.cards = [draftToCard(normalizeDraft(synthesisDraft()) as FlashcardDraft, 'm', { genId: () => 'c2' })]
    const index = buildCardIndex([deckA, deckB])
    expect(index['c1'].sourceNotePath).toBe('a.md')
    expect(index['c2'].sourceNotePath).toBe('b.md')
  })
})

describe('findSourceQuoteOffset', () => {
  const body = 'Intro line.\n\nThe mitochondria is the powerhouse of the cell.\n\nMore text.'
  it('finds an exact quote and returns its offset', () => {
    const quote = 'powerhouse of the cell'
    expect(findSourceQuoteOffset(body, quote)).toBe(body.indexOf(quote))
  })
  it('matches across collapsed whitespace/newlines', () => {
    // Quote captured with a single space where the note has a newline.
    expect(findSourceQuoteOffset('a\nfoo   bar\nb', 'foo bar')).toBe(2)
  })
  it('returns null when the quote is absent or empty', () => {
    expect(findSourceQuoteOffset(body, 'not present')).toBeNull()
    expect(findSourceQuoteOffset(body, '   ')).toBeNull()
    expect(findSourceQuoteOffset('', 'x')).toBeNull()
  })
})

describe('difficultyLabel', () => {
  it('maps 1–4 to labels and clamps out-of-range/fractional values', () => {
    expect(difficultyLabel(1)).toBe('Easy')
    expect(difficultyLabel(2)).toBe('Moderate')
    expect(difficultyLabel(3)).toBe('Hard')
    expect(difficultyLabel(4)).toBe('Very hard')
    expect(difficultyLabel(0)).toBe('Easy')
    expect(difficultyLabel(9)).toBe('Very hard')
    expect(difficultyLabel(2.4)).toBe('Moderate')
  })
})

describe('grading helpers', () => {
  it('scoreRubric weights met criteria', () => {
    const rubric = validRubric() // weights 2 + 1 = 3
    expect(scoreRubric(rubric, [{ criterionId: 'k1', met: true }, { criterionId: 'k2', met: false }])).toBeCloseTo(2 / 3)
    expect(scoreRubric(rubric, [{ criterionId: 'k1', met: true }, { criterionId: 'k2', met: true }])).toBe(1)
    expect(scoreRubric(rubric, [])).toBe(0)
  })

  it('scoreToRating applies thresholds', () => {
    expect(scoreToRating(0)).toBe('again')
    expect(scoreToRating(0.24)).toBe('again')
    expect(scoreToRating(0.25)).toBe('hard')
    expect(scoreToRating(0.59)).toBe('hard')
    expect(scoreToRating(0.6)).toBe('good')
    expect(scoreToRating(0.89)).toBe('good')
    expect(scoreToRating(0.9)).toBe('easy')
    expect(scoreToRating(1)).toBe('easy')
  })

  it('checkRecallAnswer normalizes case/whitespace and matches back or acceptableAnswers', () => {
    expect(checkRecallAnswer('  The   ANSWER ', 'the answer')).toBe(true)
    expect(checkRecallAnswer('alt', 'the answer', ['ALT'])).toBe(true)
    expect(checkRecallAnswer('nope', 'the answer', ['alt'])).toBe(false)
    expect(checkRecallAnswer('   ', 'the answer')).toBe(false)
  })
})
