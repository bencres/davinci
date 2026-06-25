import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  difficultyLabel,
  findSourceQuoteOffset,
  notePathFromFlashcardsTab,
  flashcardsTitleFromTab,
  KIND_INFO,
  RECALL_SUBTYPES,
  RECALL_SUBTYPE_INFO,
  SYNTHESIS_SUBTYPES,
  SYNTHESIS_SUBTYPE_INFO,
  type FlashcardDraft,
  type FlashcardKind,
  type RecallSubtype,
  type Rubric,
  type RubricCriterion,
  type SynthesisSubtype
} from '@shared/flashcards'
import { matchesSequenceToken, matchesShortcut } from '../lib/keymaps'
import { isAppOverlayOpen } from '../lib/overlay-open'
import { ArrowUpRightIcon, InfoIcon } from './icons'

const CARD_MIX_OPTIONS = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'recall', label: 'Recall' },
  { value: 'synthesis', label: 'Synthesis' }
] as const

/** A fresh rubric to seed when a card is switched to synthesis. */
function blankRubric(): Rubric {
  return {
    criteria: [{ id: crypto.randomUUID(), description: '', weight: 1 }],
    modelAnswer: ''
  }
}

interface Props {
  tabPath: string
  isActive: boolean
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

const labelList = (values: string[]): string => values.join(', ')
const parseLabels = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)

/** A small kind/subtype badge. */
function CardBadge({ draft }: { draft: FlashcardDraft }): JSX.Element {
  const recall = draft.kind === 'recall'
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.12em]',
        recall
          ? 'bg-sky-500/12 text-sky-700'
          : 'bg-violet-500/12 text-violet-700'
      ].join(' ')}
    >
      {draft.kind} · {draft.subtype}
    </span>
  )
}

export function FlashcardReviewView({ tabPath, isActive }: Props): JSX.Element {
  const notePath = useMemo(() => notePathFromFlashcardsTab(tabPath), [tabPath])
  const title = flashcardsTitleFromTab(tabPath)

  const reviewNote = useStore((s) => s.flashcardReviewNote)
  const reviewMode = useStore((s) => s.flashcardReviewMode)
  const drafts = useStore((s) => s.flashcardDraftCards)
  const kept = useStore((s) => s.flashcardDraftKept)
  const status = useStore((s) => s.flashcardGenStatus)
  const error = useStore((s) => s.flashcardGenError)
  const dropped = useStore((s) => s.flashcardDropped)
  const genMoreLoading = useStore((s) => s.flashcardGenMoreLoading)
  const genOptions = useStore((s) => s.flashcardGenOptions)
  const deckByNote = useStore((s) => s.flashcardDeckByNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)

  const updateDraftCard = useStore((s) => s.updateDraftCard)
  const toggleDraftCardKept = useStore((s) => s.toggleDraftCardKept)
  const addManualCard = useStore((s) => s.addManualCard)
  const saveReviewedFlashcards = useStore((s) => s.saveReviewedFlashcards)
  const generateForActive = useStore((s) => s.generateFlashcardsForActiveNote)
  const generateMore = useStore((s) => s.generateMoreFlashcards)
  const setGenOption = useStore((s) => s.setFlashcardGenOption)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openNoteAtOffset = useStore((s) => s.openNoteAtOffset)
  const selectNote = useStore((s) => s.selectNote)

  // This tab is the "review surface" only when it matches the active review note.
  const isReviewTarget = notePath != null && notePath === reviewNote
  const savedDeck = notePath ? deckByNote[notePath] : undefined

  /** Open the source note scrolled to the card's quoted block (top of note if not found). */
  const jumpToSource = useCallback(
    async (quote: string | undefined) => {
      if (!notePath) return
      let body = useStore.getState().noteContents[notePath]?.body
      if (body == null) {
        try {
          body = (await window.zen.readNote(notePath)).body
        } catch {
          body = ''
        }
      }
      const offset = quote ? findSourceQuoteOffset(body ?? '', quote) : null
      if (offset != null) {
        await openNoteAtOffset(notePath, offset, { scrollMode: 'center' })
      } else {
        await selectNote(notePath)
      }
    },
    [notePath, openNoteAtOffset, selectNote]
  )

  const [focusedIndex, setFocusedIndex] = useState(0)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const safeFocus = Math.min(focusedIndex, Math.max(0, drafts.length - 1))
  useEffect(() => {
    if (safeFocus !== focusedIndex) setFocusedIndex(safeFocus)
  }, [focusedIndex, safeFocus])

  useEffect(() => {
    const el = rootRef.current?.querySelector<HTMLElement>(
      `[data-card-index="${cssEscape(String(safeFocus))}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [safeFocus, drafts.length])

  const acceptedIndexes = useMemo(
    () => drafts.map((_, i) => i).filter((i) => kept[i]),
    [drafts, kept]
  )

  const save = useCallback(() => {
    if (acceptedIndexes.length === 0) return
    void saveReviewedFlashcards(acceptedIndexes)
  }, [acceptedIndexes, saveReviewedFlashcards])

  // Keyboard — review-view bindings (rebindable; respect vim mode + text fields).
  useEffect(() => {
    if (!isActive || !isReviewTarget) return
    const handler = (e: KeyboardEvent): void => {
      if (isAppOverlayOpen()) return
      const active = document.activeElement as HTMLElement | null
      const inField =
        !!active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)

      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      // Save works even while a field is focused (mirrors a global ⌘S).
      if (matchesShortcut(e, keymapOverrides, 'flashcards.reviewSave')) {
        consume()
        save()
        return
      }

      if (e.key === 'Escape') {
        if (editingIndex !== null) {
          consume()
          setEditingIndex(null)
          ;(active as HTMLElement | null)?.blur?.()
          return
        }
        if (!inField) {
          consume()
          void closeActiveNote()
        }
        return
      }

      // The remaining single-key bindings only apply outside text fields and in vim mode.
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return
      const seq = (id: Parameters<typeof matchesSequenceToken>[2]): boolean =>
        vimMode && matchesSequenceToken(e, keymapOverrides, id)

      if (seq('flashcards.reviewNext') || e.key === 'ArrowDown') {
        consume()
        setFocusedIndex((i) => Math.min(drafts.length - 1, i + 1))
        return
      }
      if (seq('flashcards.reviewPrev') || e.key === 'ArrowUp') {
        consume()
        setFocusedIndex((i) => Math.max(0, i - 1))
        return
      }
      if (seq('flashcards.reviewToggleKeep') || e.key === ' ') {
        consume()
        toggleDraftCardKept(safeFocus)
        return
      }
      if (seq('flashcards.reviewEdit') || e.key === 'Enter') {
        consume()
        setEditingIndex((cur) => (cur === safeFocus ? null : safeFocus))
        return
      }
      // Regenerate replaces the whole batch — disallow while editing a saved deck.
      if (reviewMode !== 'edit' && seq('flashcards.reviewRegenerate')) {
        consume()
        setEditingIndex(null)
        void generateForActive()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    isActive,
    isReviewTarget,
    reviewMode,
    keymapOverrides,
    vimMode,
    drafts.length,
    safeFocus,
    editingIndex,
    save,
    toggleDraftCardKept,
    generateForActive,
    closeActiveNote
  ])

  const updateRubric = useCallback(
    (index: number, patch: Partial<Rubric>) => {
      const draft = drafts[index]
      if (!draft?.rubric) return
      updateDraftCard(index, { rubric: { ...draft.rubric, ...patch } })
    },
    [drafts, updateDraftCard]
  )

  const updateCriterion = useCallback(
    (index: number, criterionIdx: number, patch: Partial<RubricCriterion>) => {
      const rubric = drafts[index]?.rubric
      if (!rubric) return
      const criteria = rubric.criteria.map((c, i) => (i === criterionIdx ? { ...c, ...patch } : c))
      updateRubric(index, { criteria })
    },
    [drafts, updateRubric]
  )

  const addCriterion = useCallback(
    (index: number) => {
      const rubric = drafts[index]?.rubric
      if (!rubric || rubric.criteria.length >= 4) return
      updateRubric(index, {
        criteria: [...rubric.criteria, { id: crypto.randomUUID(), description: '', weight: 1 }]
      })
    },
    [drafts, updateRubric]
  )

  const removeCriterion = useCallback(
    (index: number, criterionIdx: number) => {
      const rubric = drafts[index]?.rubric
      if (!rubric || rubric.criteria.length <= 1) return
      updateRubric(index, { criteria: rubric.criteria.filter((_, i) => i !== criterionIdx) })
    },
    [drafts, updateRubric]
  )

  // Switch a card's kind, seeding/dropping the rubric and resetting to a valid subtype.
  const changeKind = useCallback(
    (index: number, kind: FlashcardKind) => {
      const draft = drafts[index]
      if (!draft || draft.kind === kind) return
      if (kind === 'synthesis') {
        updateDraftCard(index, {
          kind: 'synthesis',
          subtype: 'application',
          rubric: draft.rubric ?? blankRubric(),
          acceptableAnswers: undefined
        })
      } else {
        updateDraftCard(index, { kind: 'recall', subtype: 'cued', rubric: undefined })
      }
    },
    [drafts, updateDraftCard]
  )

  const addCard = useCallback(() => {
    const idx = addManualCard()
    setFocusedIndex(idx)
    setEditingIndex(idx)
  }, [addManualCard])

  return (
    <div
      ref={rootRef}
      data-preview-scroll
      tabIndex={0}
      onMouseDownCapture={() => setFocusedPanel('editor')}
      onFocusCapture={() => setFocusedPanel('editor')}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6">
        <header className="flex flex-col gap-1">
          <div className="text-xs font-medium uppercase tracking-[0.2em] text-ink-500">
            Study
          </div>
          <h1 className="font-serif text-2xl font-semibold text-ink-900">{title}</h1>
          <div className="text-sm text-ink-500">{notePath}</div>
        </header>

        {isReviewTarget && status === 'configuring' && (
          <div className="flex flex-col gap-4 rounded-2xl border border-paper-300/70 bg-paper-50/50 px-5 py-5">
            <div className="text-sm font-medium text-ink-800">Custom generation</div>
            <Pills
              label="Density"
              value={genOptions.density}
              options={[
                { value: 'concise', label: 'Concise' },
                { value: 'balanced', label: 'Balanced' },
                { value: 'thorough', label: 'Thorough' }
              ]}
              onChange={(density) => setGenOption({ density })}
            />
            <Pills
              label="Card mix"
              value={genOptions.cardMix}
              options={CARD_MIX_OPTIONS}
              onChange={(cardMix) => setGenOption({ cardMix })}
            />
            <Field label="Max cards (optional)">
              <input
                type="number"
                min={1}
                max={20}
                value={genOptions.maxCards ?? ''}
                placeholder="Up to 20"
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10)
                  setGenOption({ maxCards: Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : null })
                }}
                className={`${inputClass} w-32`}
              />
            </Field>
            <Field label="Custom instructions (optional)">
              <textarea
                rows={3}
                value={genOptions.instructions}
                placeholder="e.g. Focus on the proofs; write cloze cards for the key formulas; keep answers terse."
                onChange={(e) => setGenOption({ instructions: e.target.value })}
                className={inputClass}
              />
            </Field>
            <div className="text-xs text-ink-500">
              The model is set in Settings → Study. Card count still follows the note's concepts and a per-run cap.
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void generateForActive()}
                className="rounded-xl bg-accent/90 px-4 py-2 text-sm font-medium text-white hover:bg-accent"
              >
                Generate
              </button>
              <button
                type="button"
                onClick={() => void closeActiveNote()}
                className="rounded-xl border border-paper-300/70 bg-paper-100/80 px-3 py-2 text-xs font-medium text-ink-800 hover:bg-paper-200"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {isReviewTarget && status === 'generating' && (
          <div className="flex items-center gap-3 rounded-2xl border border-paper-300/70 bg-paper-50/50 px-5 py-6 text-sm text-ink-600">
            <span className="inline-flex h-3 w-3 animate-pulse rounded-full bg-accent/70" />
            Generating study cards with Claude…
          </div>
        )}

        {isReviewTarget && status === 'error' && (
          <div className="rounded-2xl border border-red-400/30 bg-red-500/8 px-5 py-5 text-sm text-ink-800">
            <div className="font-medium text-[rgb(var(--z-red))]">Generation failed</div>
            <div className="mt-1 text-ink-600">{error}</div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void generateForActive()}
                className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
              >
                Open Settings
              </button>
            </div>
          </div>
        )}

        {isReviewTarget && status === 'reviewing' && drafts.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm text-ink-600">
                {reviewMode === 'edit'
                  ? 'Edit saved cards; discard any to delete them on save, or add new ones. '
                  : 'Review, edit, and keep the cards you want. '}
                {dropped > 0 && (
                  <span className="text-ink-500">{dropped} card{dropped === 1 ? '' : 's'} dropped as invalid.</span>
                )}
                {error && <span className="text-[rgb(var(--z-red))]"> {error}</span>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={addCard}
                  className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
                >
                  + Add card
                </button>
                <button
                  type="button"
                  onClick={() => void generateMore()}
                  disabled={genMoreLoading}
                  className={[
                    'rounded-lg border border-paper-300/70 px-3 py-1.5 text-xs font-medium transition-colors',
                    genMoreLoading
                      ? 'cursor-default bg-paper-100/50 text-ink-400'
                      : 'bg-paper-100/80 text-ink-800 hover:bg-paper-200'
                  ].join(' ')}
                >
                  {genMoreLoading ? 'Generating…' : 'Generate more'}
                </button>
                {reviewMode !== 'edit' && (
                  <button
                    type="button"
                    onClick={() => void generateForActive()}
                    disabled={genMoreLoading}
                    className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200 disabled:cursor-default disabled:text-ink-400"
                  >
                    Regenerate
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {drafts.map((draft, index) => {
                const focused = index === safeFocus
                const editing = index === editingIndex
                const discarded = !kept[index]
                return (
                  <section
                    key={index}
                    data-card-index={index}
                    onMouseMove={() => setFocusedIndex(index)}
                    className={[
                      'rounded-2xl border px-4 py-4 transition-colors',
                      discarded ? 'opacity-55' : '',
                      focused
                        ? 'border-accent/45 bg-paper-100/60'
                        : 'border-paper-300/70 bg-paper-50/45'
                    ].join(' ')}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <CardBadge draft={draft} />
                        <span className="rounded-full bg-paper-200/70 px-2 py-0.5 text-2xs font-medium text-ink-600">
                          {difficultyLabel(draft.difficulty)}
                        </span>
                        {draft.concepts[0] && (
                          <span className="rounded-full bg-amber-500/12 px-2 py-0.5 text-2xs font-medium text-amber-700">
                            focus: {draft.concepts[0]}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditingIndex(editing ? null : index)}
                          className="rounded-lg bg-paper-100/85 px-2.5 py-1 text-xs font-medium text-ink-700 hover:bg-paper-200"
                        >
                          {editing ? 'Done' : 'Edit'}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleDraftCardKept(index)}
                          className={[
                            'rounded-lg px-2.5 py-1 text-xs font-medium',
                            discarded
                              ? 'bg-paper-100/85 text-ink-600 hover:bg-paper-200'
                              : 'bg-emerald-500/12 text-emerald-700 hover:bg-emerald-500/18'
                          ].join(' ')}
                        >
                          {discarded ? 'Discarded' : 'Kept'}
                        </button>
                      </div>
                    </div>

                    {editing ? (
                      <div className="mt-3 flex flex-col gap-3 text-sm">
                        <div className="grid grid-cols-3 gap-3">
                          <Field label="Kind" info={<KindInfo />}>
                            <select
                              value={draft.kind}
                              onChange={(e) => changeKind(index, e.target.value as FlashcardKind)}
                              className={inputClass}
                            >
                              <option value="recall">recall</option>
                              <option value="synthesis">synthesis</option>
                            </select>
                          </Field>
                          <Field label="Subtype" info={<SubtypeInfo kind={draft.kind} />}>
                            <select
                              value={draft.subtype}
                              onChange={(e) =>
                                updateDraftCard(index, {
                                  subtype: e.target.value as RecallSubtype | SynthesisSubtype
                                })
                              }
                              className={inputClass}
                            >
                              {(draft.kind === 'recall' ? RECALL_SUBTYPES : SYNTHESIS_SUBTYPES).map(
                                (st) => (
                                  <option key={st} value={st}>
                                    {st}
                                  </option>
                                )
                              )}
                            </select>
                          </Field>
                          <Field label="Difficulty">
                            <select
                              value={draft.difficulty}
                              onChange={(e) =>
                                updateDraftCard(index, {
                                  difficulty: Number(e.target.value) as FlashcardDraft['difficulty']
                                })
                              }
                              className={inputClass}
                            >
                              {[1, 2, 3, 4].map((d) => (
                                <option key={d} value={d}>
                                  {difficultyLabel(d)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </div>
                        <Field label="Front (prompt)">
                          <textarea
                            value={draft.front}
                            rows={2}
                            onChange={(e) => updateDraftCard(index, { front: e.target.value })}
                            className={inputClass}
                          />
                        </Field>
                        <Field label={draft.kind === 'recall' ? 'Back (answer)' : 'Back (model answer)'}>
                          <textarea
                            value={draft.back}
                            rows={2}
                            onChange={(e) => updateDraftCard(index, { back: e.target.value })}
                            className={inputClass}
                          />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          <Field label="Concepts (≤3, comma-separated)">
                            <LabelInput
                              value={draft.concepts}
                              onChange={(concepts) => updateDraftCard(index, { concepts })}
                              className={inputClass}
                            />
                          </Field>
                          <Field label="Prerequisites (≤3, comma-separated)">
                            <LabelInput
                              value={draft.prerequisites}
                              onChange={(prerequisites) => updateDraftCard(index, { prerequisites })}
                              className={inputClass}
                            />
                          </Field>
                        </div>
                        {draft.kind === 'synthesis' && draft.rubric && (
                          <div className="rounded-xl border border-paper-300/60 bg-paper-100/40 px-3 py-3">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-500">
                                Rubric · a good answer includes
                              </div>
                              <button
                                type="button"
                                onClick={() => addCriterion(index)}
                                disabled={draft.rubric.criteria.length >= 4}
                                className="rounded-md px-1.5 py-0.5 text-2xs font-medium text-ink-600 hover:bg-paper-200 disabled:text-ink-300"
                              >
                                + Criterion
                              </button>
                            </div>
                            <div className="mt-2 flex flex-col gap-2">
                              {draft.rubric.criteria.map((c, ci) => (
                                <div key={c.id} className="flex items-center gap-2">
                                  <input
                                    value={c.description}
                                    placeholder="what a good answer must show"
                                    onChange={(e) =>
                                      updateCriterion(index, ci, { description: e.target.value })
                                    }
                                    className={`${inputClass} flex-1`}
                                  />
                                  <input
                                    type="number"
                                    min={1}
                                    max={3}
                                    value={c.weight}
                                    title="weight (1–3)"
                                    onChange={(e) =>
                                      updateCriterion(index, ci, {
                                        weight: Math.max(1, Math.min(3, Number(e.target.value) || 1))
                                      })
                                    }
                                    className={`${inputClass} w-16`}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => removeCriterion(index, ci)}
                                    disabled={draft.rubric!.criteria.length <= 1}
                                    title="Remove criterion"
                                    className="rounded-md px-1.5 py-1 text-xs text-ink-400 hover:bg-paper-200 hover:text-[rgb(var(--z-red))] disabled:opacity-40"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="mt-2">
                              <Field label="Model answer">
                                <textarea
                                  value={draft.rubric.modelAnswer}
                                  rows={2}
                                  onChange={(e) =>
                                    updateRubric(index, { modelAnswer: e.target.value })
                                  }
                                  className={inputClass}
                                />
                              </Field>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-col gap-2 text-sm">
                        <div>
                          <div className="text-2xs uppercase tracking-[0.14em] text-ink-500">Front</div>
                          <div className="mt-0.5 text-ink-900">{draft.front}</div>
                        </div>
                        <div>
                          <div className="text-2xs uppercase tracking-[0.14em] text-ink-500">
                            {draft.kind === 'recall' ? 'Back' : 'Model answer'}
                          </div>
                          <div className="mt-0.5 whitespace-pre-wrap text-ink-700">{draft.back}</div>
                        </div>
                        {draft.kind === 'synthesis' && draft.rubric && (
                          <div>
                            <div className="text-2xs uppercase tracking-[0.14em] text-ink-500">
                              A good answer includes
                            </div>
                            <ul className="mt-1 list-disc pl-5 text-ink-700">
                              {draft.rubric.criteria.map((c) => (
                                <li key={c.id}>
                                  {c.description}{' '}
                                  <span className="text-ink-400">({c.weight})</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {draft.prerequisites.length > 0 && (
                          <div className="text-xs text-ink-500">
                            Prerequisites: {labelList(draft.prerequisites)}
                          </div>
                        )}
                        {draft.sourceQuote && (
                          <SourceLink
                            quote={draft.sourceQuote}
                            onJump={() => void jumpToSource(draft.sourceQuote)}
                          />
                        )}
                      </div>
                    )}
                  </section>
                )
              })}
            </div>

            <footer className="sticky bottom-0 flex items-center justify-between gap-3 rounded-2xl border border-paper-300/70 bg-paper-50/90 px-5 py-3 backdrop-blur">
              <div className="text-sm text-ink-600">
                {acceptedIndexes.length} of {drafts.length} cards kept
              </div>
              <button
                type="button"
                onClick={save}
                disabled={acceptedIndexes.length === 0}
                className={[
                  'rounded-xl px-4 py-2 text-sm font-medium transition-colors',
                  acceptedIndexes.length === 0
                    ? 'cursor-default bg-paper-200/60 text-ink-400'
                    : 'bg-accent/90 text-white hover:bg-accent'
                ].join(' ')}
              >
                Save {acceptedIndexes.length} card{acceptedIndexes.length === 1 ? '' : 's'}
              </button>
            </footer>
          </>
        )}

        {isReviewTarget && status === 'reviewing' && drafts.length === 0 && (
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-paper-300/70 bg-paper-50/50 px-5 py-6 text-sm text-ink-600">
            <div>
              No cards yet. {dropped > 0 ? `${dropped} card(s) were dropped as invalid. ` : ''}
              Add your own, or generate some with Claude.
              {error && <span className="text-[rgb(var(--z-red))]"> {error}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={addCard}
                className="rounded-lg bg-accent/90 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-accent"
              >
                + Add card
              </button>
              <button
                type="button"
                onClick={() => void generateForActive()}
                className="rounded-lg border border-paper-300/70 bg-paper-100/80 px-3.5 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
              >
                Generate with Claude
              </button>
            </div>
          </div>
        )}

        {/* Saved deck (shown when present — but not while editing it, since the
            same cards are already on the editable surface above). */}
        {savedDeck && savedDeck.cards.length > 0 && !(isReviewTarget && status === 'reviewing' && reviewMode === 'edit') && (
          <section className="flex flex-col gap-2">
            <div className="text-sm font-medium text-ink-700">
              Saved deck · {savedDeck.cards.length} card{savedDeck.cards.length === 1 ? '' : 's'}
            </div>
            <div className="flex flex-col gap-2">
              {savedDeck.cards.map((card) => (
                <div
                  key={card.id}
                  className="rounded-xl border border-paper-300/60 bg-paper-50/40 px-4 py-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <CardBadge draft={card} />
                      {card.userEdited && (
                        <span className="text-2xs text-ink-400">edited</span>
                      )}
                    </div>
                    {card.sourceQuote && (
                      <button
                        type="button"
                        onClick={() => void jumpToSource(card.sourceQuote)}
                        title="Open the source block in the note"
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-ink-500 transition-colors hover:bg-paper-100/70 hover:text-accent"
                      >
                        Source
                        <ArrowUpRightIcon width={11} height={11} />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 text-ink-900">{card.front}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {!isReviewTarget && !savedDeck && (
          <div className="rounded-2xl border border-paper-300/70 bg-paper-50/50 px-5 py-6 text-sm text-ink-600">
            No saved study cards for this note yet. Run “Generate Study Cards from This Note”.
          </div>
        )}
      </div>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-paper-300/70 bg-paper-50/80 px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-accent/45'

function Field({
  label,
  info,
  children
}: {
  label: string
  info?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-2xs uppercase tracking-[0.14em] text-ink-500">
        {label}
        {info != null && <InfoHint>{info}</InfoHint>}
      </span>
      {children}
    </label>
  )
}

/**
 * Comma-separated label editor that keeps its own raw text buffer so spaces and
 * trailing commas survive while typing (the store still receives a normalized
 * 1–3 array via `parseLabels`). Re-syncs from props only when the external value
 * genuinely diverges from what the buffer represents (card switch / external edit).
 */
function LabelInput({
  value,
  onChange,
  className
}: {
  value: string[]
  onChange: (next: string[]) => void
  className?: string
}): JSX.Element {
  const [text, setText] = useState(() => value.join(', '))
  useEffect(() => {
    if (parseLabels(text).join('\n') !== value.join('\n')) {
      setText(value.join(', '))
    }
    // Intentionally only react to external `value` changes, not local keystrokes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        onChange(parseLabels(e.target.value))
      }}
      className={className}
    />
  )
}

/** A small ⓘ affordance that reveals explanatory copy on hover/focus. */
function InfoHint({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="What is this?"
        onClick={(e) => e.preventDefault()}
        className="text-ink-400 transition-colors hover:text-accent focus:text-accent focus:outline-none"
      >
        <InfoIcon width={13} height={13} />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-72 rounded-lg border border-paper-300/70 bg-paper-50 px-3 py-2 text-2xs font-normal normal-case leading-relaxed tracking-normal text-ink-700 shadow-lg group-hover:block group-focus-within:block"
      >
        {children}
      </span>
    </span>
  )
}

/** Popover body explaining the two card kinds. */
function KindInfo(): JSX.Element {
  return (
    <span className="flex flex-col gap-1">
      <span>
        <b className="font-semibold">recall</b> — {KIND_INFO.recall}
      </span>
      <span>
        <b className="font-semibold">synthesis</b> — {KIND_INFO.synthesis}
      </span>
    </span>
  )
}

/** Popover body listing each subtype valid for the current kind. */
function SubtypeInfo({ kind }: { kind: FlashcardKind }): JSX.Element {
  const entries: [string, string][] =
    kind === 'recall'
      ? RECALL_SUBTYPES.map((st) => [st, RECALL_SUBTYPE_INFO[st]])
      : SYNTHESIS_SUBTYPES.map((st) => [st, SYNTHESIS_SUBTYPE_INFO[st]])
  return (
    <span className="flex flex-col gap-1">
      {entries.map(([st, desc]) => (
        <span key={st}>
          <b className="font-semibold">{st}</b> — {desc}
        </span>
      ))}
    </span>
  )
}

/** A small segmented pill control for the custom-generation form. */
function Pills<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (next: T) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-[0.14em] text-ink-500">{label}</span>
      <div className="inline-flex w-fit rounded-xl border border-paper-300/70 bg-paper-100/75 p-1">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={[
              'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
              value === o.value ? 'bg-paper-50 text-ink-900 shadow-sm' : 'text-ink-600 hover:text-ink-900'
            ].join(' ')}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Clickable source-quote block that jumps to the originating block in the note. */
function SourceLink({
  quote,
  onJump
}: {
  quote: string
  onJump: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onJump}
      title="Open the source block in the note"
      className="group flex w-full items-start gap-1.5 rounded-md border-l-2 border-paper-300 bg-transparent px-3 py-1 text-left text-xs italic text-ink-500 transition-colors hover:border-accent/60 hover:bg-paper-100/60 hover:text-ink-700"
    >
      <span className="min-w-0 flex-1">{quote}</span>
      <ArrowUpRightIcon
        width={12}
        height={12}
        className="mt-0.5 shrink-0 text-ink-400 transition-colors group-hover:text-accent"
      />
    </button>
  )
}
