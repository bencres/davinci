// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Flashcard, FlashcardDeck, FlashcardDraft, SrsState } from '@shared/flashcards'

const NOTE = 'inbox/Topic.md'

const recallDraft: FlashcardDraft = {
  kind: 'recall',
  subtype: 'cued',
  front: 'What is X?',
  back: 'X is a thing.',
  concepts: ['X'],
  prerequisites: [],
  difficulty: 2
}

const synthesisDraft: FlashcardDraft = {
  kind: 'synthesis',
  subtype: 'application',
  front: 'Apply X to a new case.',
  back: 'You would…',
  concepts: ['X'],
  prerequisites: [],
  difficulty: 4,
  rubric: {
    criteria: [{ id: 'c1', description: 'Names the mechanism', weight: 2 }],
    modelAnswer: 'A full-credit answer.'
  }
}

let generateMock: ReturnType<typeof vi.fn>
let writeMock: ReturnType<typeof vi.fn>

function installZen(): void {
  generateMock = vi.fn().mockResolvedValue({ drafts: [recallDraft, synthesisDraft], dropped: 1 })
  // Echo the written deck back, as the real bridge does.
  writeMock = vi.fn().mockImplementation((_n: string, deck: FlashcardDeck) => Promise.resolve(deck))
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
      generateFlashcards: generateMock,
      readFlashcards: vi.fn().mockResolvedValue(null),
      writeFlashcards: writeMock
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

describe('flashcards store slice', () => {
  it('generation populates the review batch and passes the active gen options', async () => {
    const { useStore } = await loadStore()
    useStore.setState({
      flashcardReviewNote: NOTE,
      flashcardGenOptions: {
        density: 'thorough',
        cardMix: 'synthesis',
        instructions: 'be terse',
        maxCards: 7
      }
    })
    await useStore.getState().generateFlashcardsForActiveNote()

    const s = useStore.getState()
    expect(generateMock).toHaveBeenCalledWith(
      NOTE,
      expect.objectContaining({
        model: expect.any(String),
        density: 'thorough',
        cardMix: 'synthesis',
        instructions: 'be terse',
        maxCards: 7
      })
    )
    expect(s.flashcardGenStatus).toBe('reviewing')
    expect(s.flashcardDraftCards).toHaveLength(2)
    expect(s.flashcardDraftKept).toEqual([true, true])
    expect(s.flashcardDropped).toBe(1)
  })

  it('custom mode opens the config form without generating; manual opens an empty list', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().openFlashcardReview(NOTE, 'custom')
    expect(useStore.getState().flashcardGenStatus).toBe('configuring')
    expect(generateMock).not.toHaveBeenCalled()

    await useStore.getState().openFlashcardReview(NOTE, 'manual')
    expect(useStore.getState().flashcardGenStatus).toBe('reviewing')
    expect(useStore.getState().flashcardDraftCards).toHaveLength(0)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('addManualCard appends a blank recall card on the reviewing surface', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().openFlashcardReview(NOTE, 'manual')
    const idx = useStore.getState().addManualCard()
    const s = useStore.getState()
    expect(idx).toBe(0)
    expect(s.flashcardDraftCards[0]).toMatchObject({ kind: 'recall', subtype: 'cued', front: '' })
    expect(s.flashcardDraftEdited[0]).toBe(true)
    expect(s.flashcardGenStatus).toBe('reviewing')
  })

  it('saveReviewedFlashcards skips contract-invalid (e.g. blank manual) cards', async () => {
    const { useStore } = await loadStore()
    await useStore.getState().openFlashcardReview(NOTE, 'manual')
    const idx = useStore.getState().addManualCard() // blank front/back → invalid
    await useStore.getState().saveReviewedFlashcards([idx])
    expect(writeMock).not.toHaveBeenCalled()
    expect(useStore.getState().flashcardGenError).toMatch(/incomplete/i)
  })

  it('generateMoreFlashcards appends and excludes existing fronts/concepts', async () => {
    const { useStore } = await loadStore()
    useStore.setState({ flashcardReviewNote: NOTE })
    await useStore.getState().generateFlashcardsForActiveNote()
    expect(useStore.getState().flashcardDraftCards).toHaveLength(2)

    await useStore.getState().generateMoreFlashcards()

    const s = useStore.getState()
    // The second batch (mock returns the same 2) is appended → 4 total.
    expect(s.flashcardDraftCards).toHaveLength(4)
    expect(s.flashcardDraftKept).toHaveLength(4)
    expect(s.flashcardGenMoreLoading).toBe(false)
    // The "more" call was told to avoid the already-present cards.
    const lastCall = generateMock.mock.calls.at(-1)?.[1] as { existing?: string[] }
    expect(lastCall.existing).toContain('What is X?')
  })

  it('updateDraftCard patches the card and marks it user-edited', async () => {
    const { useStore } = await loadStore()
    useStore.setState({ flashcardReviewNote: NOTE })
    await useStore.getState().generateFlashcardsForActiveNote()

    useStore.getState().updateDraftCard(0, { front: 'Edited front' })
    const s = useStore.getState()
    expect(s.flashcardDraftCards[0].front).toBe('Edited front')
    expect(s.flashcardDraftEdited).toEqual([true, false])
  })

  it('saveReviewedFlashcards writes only accepted cards with srs initialized + edit flag', async () => {
    const { useStore } = await loadStore()
    useStore.setState({ flashcardReviewNote: NOTE })
    await useStore.getState().generateFlashcardsForActiveNote()

    // Edit card 0, then save only card 0 (drop card 1).
    useStore.getState().updateDraftCard(0, { back: 'Edited back' })
    await useStore.getState().saveReviewedFlashcards([0])

    expect(writeMock).toHaveBeenCalledTimes(1)
    const [, deck] = writeMock.mock.calls[0] as [string, FlashcardDeck]
    expect(deck.cards).toHaveLength(1)
    expect(deck.cards[0].front).toBe('What is X?')
    expect(deck.cards[0].back).toBe('Edited back')
    expect(deck.cards[0].userEdited).toBe(true)
    expect(deck.cards[0].srs.state).toBe('new')
    expect(deck.cards[0].srs.due).toBeNull()
    expect(deck.cards[0].id).toBeTruthy()

    // The deck is cached and the review batch cleared.
    const s = useStore.getState()
    expect(s.flashcardDeckByNote[NOTE]?.cards).toHaveLength(1)
    expect(s.flashcardDraftCards).toHaveLength(0)
  })

  it('saving an unaccepted-only set is a no-op (nothing written)', async () => {
    const { useStore } = await loadStore()
    useStore.setState({ flashcardReviewNote: NOTE })
    await useStore.getState().generateFlashcardsForActiveNote()
    await useStore.getState().saveReviewedFlashcards([])
    expect(writeMock).not.toHaveBeenCalled()
  })

  it('edit mode loads the saved deck, preserves identity, and replaces on save', async () => {
    const { useStore } = await loadStore()
    const srs: SrsState = {
      state: 'review',
      due: '2026-07-01T00:00:00.000Z',
      stability: 3.2,
      difficulty: 5.1,
      reps: 4,
      lapses: 1,
      lastReview: '2026-06-20T00:00:00.000Z'
    }
    const c1: Flashcard = {
      ...recallDraft,
      id: 'card-1',
      srs,
      userEdited: false,
      createdAt: 111,
      generatedBy: 'claude-x'
    }
    const c2: Flashcard = {
      ...synthesisDraft,
      id: 'card-2',
      srs: { ...srs, reps: 9 },
      userEdited: true,
      createdAt: 222,
      generatedBy: 'claude-y'
    }
    const deck: FlashcardDeck = { version: 1, sourceNotePath: NOTE, cards: [c1, c2] }
    // Seed the cached deck so edit mode has something to load (readFlashcards → null).
    useStore.setState({ flashcardDeckByNote: { [NOTE]: deck } })

    await useStore.getState().openFlashcardReview(NOTE, 'edit')
    const opened = useStore.getState()
    expect(opened.flashcardReviewMode).toBe('edit')
    expect(opened.flashcardGenStatus).toBe('reviewing')
    expect(opened.flashcardDraftCards).toHaveLength(2)
    expect(opened.flashcardDraftOrigin.map((o) => o?.id)).toEqual(['card-1', 'card-2'])

    // Edit card 0 and keep only it — card 1 is dropped (delete on save).
    useStore.getState().updateDraftCard(0, { front: 'Edited front' })
    await useStore.getState().saveReviewedFlashcards([0])

    expect(writeMock).toHaveBeenCalledTimes(1)
    const [, savedDeck] = writeMock.mock.calls[0] as [string, FlashcardDeck]
    // Replaced, not appended: only the kept card remains.
    expect(savedDeck.cards).toHaveLength(1)
    const saved = savedDeck.cards[0]
    expect(saved.id).toBe('card-1') // identity preserved
    expect(saved.front).toBe('Edited front') // edit applied
    expect(saved.srs).toEqual(srs) // scheduling state preserved
    expect(saved.createdAt).toBe(111) // createdAt preserved
    expect(saved.userEdited).toBe(true) // flagged as edited
  })

  it('surfaces a friendly message when generation reports no API key', async () => {
    const { useStore } = await loadStore()
    generateMock.mockRejectedValueOnce(new Error('NO_ANTHROPIC_KEY: missing'))
    useStore.setState({ flashcardReviewNote: NOTE })
    await useStore.getState().generateFlashcardsForActiveNote()
    const s = useStore.getState()
    expect(s.flashcardGenStatus).toBe('error')
    expect(s.flashcardGenError).toContain('Settings')
  })
})
