// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flashcard, FlashcardDeck, SrsState } from '@shared/flashcards'

const NOTE = 'inbox/Topic.md'

const newSrs: SrsState = {
  state: 'new',
  due: null,
  stability: null,
  difficulty: null,
  reps: 0,
  lapses: 0,
  lastReview: null
}
const dueSrs: SrsState = {
  state: 'review',
  due: '2020-01-01T00:00:00.000Z', // long past → due
  stability: 10,
  difficulty: 5,
  reps: 3,
  lapses: 0,
  lastReview: '2019-12-01T00:00:00.000Z'
}

const cardDue: Flashcard = {
  id: 'due',
  kind: 'recall',
  subtype: 'cued',
  front: 'Due front',
  back: 'Due back',
  concepts: ['X'],
  prerequisites: [],
  difficulty: 2,
  srs: dueSrs,
  userEdited: false,
  createdAt: 50,
  generatedBy: 'test'
}
const cardNew: Flashcard = {
  ...cardDue,
  id: 'new',
  front: 'New front',
  back: 'New back',
  srs: newSrs,
  createdAt: 100
}

let writeMock: ReturnType<typeof vi.fn>
let listMock: ReturnType<typeof vi.fn>
let appendLogMock: ReturnType<typeof vi.fn>

function deck(): FlashcardDeck {
  return { version: 1, sourceNotePath: NOTE, cards: [structuredClone(cardDue), structuredClone(cardNew)] }
}

function installZen(): void {
  writeMock = vi.fn().mockImplementation((_n: string, d: FlashcardDeck) => Promise.resolve(d))
  listMock = vi
    .fn()
    .mockResolvedValue([{ sourceNotePath: NOTE, deckPath: 'x', cardCount: 2 }])
  appendLogMock = vi
    .fn()
    .mockImplementation((n: string, g: unknown) =>
      Promise.resolve({ version: 1, sourceNotePath: n, grades: [g] })
    )
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: {
      getCapabilities: vi.fn().mockReturnValue({
        supportsUpdater: false,
        supportsNativeMenus: false,
        supportsFloatingWindows: false,
        supportsLocalFilesystemPickers: true,
        supportsRemoteWorkspace: false,
        supportsCliInstall: false,
        supportsCustomTemplates: false
      }),
      scanTasks: vi.fn().mockResolvedValue([]),
      listNotes: vi.fn().mockResolvedValue([]),
      listFolders: vi.fn().mockResolvedValue([]),
      listLocalVaults: vi.fn().mockResolvedValue([]),
      listAssets: vi.fn().mockResolvedValue([]),
      hasAssetsDir: vi.fn().mockResolvedValue(false),
      getRemoteWorkspaceInfo: vi.fn().mockResolvedValue(null),
      getVaultSettings: vi.fn().mockResolvedValue({}),
      listFlashcardDecks: listMock,
      readFlashcards: vi.fn().mockResolvedValue(deck()),
      writeFlashcards: writeMock,
      readReviewLog: vi.fn().mockResolvedValue(null),
      appendReviewGrade: appendLogMock
    }
  })
}

async function loadStore() {
  vi.resetModules()
  localStorage.clear()
  installZen()
  return import('./store')
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('study-session store slice', () => {
  it('builds a due-first queue across decks and enters the front phase', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    const s = useStore.getState()
    expect(listMock).toHaveBeenCalled()
    expect(s.studyPhase).toBe('front')
    // Due review before the new card.
    expect(s.studyQueue).toEqual(['due', 'new'])
    expect(s.studyCursor).toBe(0)
  })

  it('grades a card: reschedules srs, persists the deck, records calibration, advances', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })

    useStore.getState().setStudyPredicted('hard')
    useStore.getState().revealCurrentCard()
    expect(useStore.getState().studyPhase).toBe('revealed')

    await useStore.getState().gradeCurrentCard('good')

    const s = useStore.getState()
    // Persisted the updated SRS for the graded card.
    expect(writeMock).toHaveBeenCalledTimes(1)
    const [, savedDeck] = writeMock.mock.calls[0] as [string, FlashcardDeck]
    const graded = savedDeck.cards.find((c) => c.id === 'due')!
    expect(graded.srs.lastReview).not.toBeNull()
    expect(graded.srs.reps).toBe(4)
    // One grade recorded with the calibration prediction.
    expect(s.studySessionGrades).toHaveLength(1)
    expect(s.studySessionGrades[0]).toMatchObject({ cardId: 'due', predictedRating: 'hard', rating: 'good' })
    // Advanced to the next card.
    expect(s.studyCursor).toBe(1)
    expect(s.studyPhase).toBe('front')
    expect(s.studyPredicted).toBeNull()
  })

  it('records synthesis grade detail (learner answer, rubric criteria, score)', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    useStore.getState().revealCurrentCard()
    await useStore.getState().gradeCurrentCard('good', {
      learnerAnswer: 'my answer',
      criteria: [{ criterionId: 'c1', met: true }],
      score: 0.75
    })
    const g = useStore.getState().studySessionGrades[0]
    expect(g).toMatchObject({
      rating: 'good',
      learnerAnswer: 'my answer',
      criteria: [{ criterionId: 'c1', met: true }],
      score: 0.75
    })
  })

  it('omits synthesis-only fields for a bare recall grade', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    useStore.getState().revealCurrentCard()
    await useStore.getState().gradeCurrentCard('good')
    const g = useStore.getState().studySessionGrades[0]
    expect('criteria' in g).toBe(false)
    expect('score' in g).toBe(false)
    expect('learnerAnswer' in g).toBe(false)
  })

  it('re-queues an Again-rated card so it returns before the session ends', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    useStore.getState().revealCurrentCard()
    await useStore.getState().gradeCurrentCard('again')
    const s = useStore.getState()
    expect(s.studyQueue).toEqual(['due', 'new', 'due'])
    expect(s.studyPhase).toBe('front')
  })

  it('reaches the summary after the last card', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    for (let i = 0; i < 2; i++) {
      useStore.getState().revealCurrentCard()
      await useStore.getState().gradeCurrentCard('good')
    }
    const s = useStore.getState()
    expect(s.studyPhase).toBe('summary')
    expect(s.studySessionGrades).toHaveLength(2)
  })

  it('persists each grade to the review log', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().startStudySession({ kind: 'all' })
    useStore.getState().revealCurrentCard()
    await useStore.getState().gradeCurrentCard('good')
    expect(appendLogMock).toHaveBeenCalledTimes(1)
    const [notePath, grade] = appendLogMock.mock.calls[0] as [string, { cardId: string }]
    expect(notePath).toBe(NOTE)
    expect(grade.cardId).toBe('due')
  })

  it('caps the new cards introduced per day from vault settings', async () => {
    const { useStore } = await loadStore()
    // Three brand-new cards; cap new/day at 1 → only one new card enters the queue.
    const threeNew: FlashcardDeck = {
      version: 1,
      sourceNotePath: NOTE,
      cards: [
        { ...structuredClone(cardNew), id: 'n1', createdAt: 1 },
        { ...structuredClone(cardNew), id: 'n2', createdAt: 2 },
        { ...structuredClone(cardNew), id: 'n3', createdAt: 3 }
      ]
    }
    ;(window.zen.readFlashcards as ReturnType<typeof vi.fn>).mockResolvedValue(threeNew)
    useStore.setState({
      vaultSettings: { ...useStore.getState().vaultSettings, flashcardNewPerDay: 1 }
    })
    await useStore.getState().startStudySession({ kind: 'all' })
    expect(useStore.getState().studyQueue).toEqual(['n1'])
  })

  it('shows an empty summary when nothing is due', async () => {
    const { useStore } = await loadStore()
    // A deck whose only card is scheduled far in the future.
    const future: FlashcardDeck = {
      version: 1,
      sourceNotePath: NOTE,
      cards: [{ ...structuredClone(cardDue), srs: { ...dueSrs, due: '2999-01-01T00:00:00.000Z' } }]
    }
    ;(window.zen.readFlashcards as ReturnType<typeof vi.fn>).mockResolvedValue(future)
    await useStore.getState().startStudySession({ kind: 'all' })
    expect(useStore.getState().studyPhase).toBe('summary')
    expect(useStore.getState().studyQueue).toHaveLength(0)
  })
})
