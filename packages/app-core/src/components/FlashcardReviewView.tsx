import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import {
  notePathFromFlashcardsTab,
  flashcardsTitleFromTab,
  type FlashcardDraft,
  type Rubric,
  type RubricCriterion
} from '@shared/flashcards'
import { matchesSequenceToken, matchesShortcut } from '../lib/keymaps'
import { isAppOverlayOpen } from '../lib/overlay-open'

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
  const drafts = useStore((s) => s.flashcardDraftCards)
  const kept = useStore((s) => s.flashcardDraftKept)
  const status = useStore((s) => s.flashcardGenStatus)
  const error = useStore((s) => s.flashcardGenError)
  const dropped = useStore((s) => s.flashcardDropped)
  const deckByNote = useStore((s) => s.flashcardDeckByNote)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const vimMode = useStore((s) => s.vimMode)

  const updateDraftCard = useStore((s) => s.updateDraftCard)
  const toggleDraftCardKept = useStore((s) => s.toggleDraftCardKept)
  const saveReviewedFlashcards = useStore((s) => s.saveReviewedFlashcards)
  const generateForActive = useStore((s) => s.generateFlashcardsForActiveNote)
  const setFocusedPanel = useStore((s) => s.setFocusedPanel)
  const closeActiveNote = useStore((s) => s.closeActiveNote)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)

  // This tab is the "review surface" only when it matches the active review note.
  const isReviewTarget = notePath != null && notePath === reviewNote
  const savedDeck = notePath ? deckByNote[notePath] : undefined

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
      if (seq('flashcards.reviewRegenerate')) {
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
                Review, edit, and keep the cards you want. {dropped > 0 && (
                  <span className="text-ink-500">{dropped} card{dropped === 1 ? '' : 's'} dropped as invalid.</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void generateForActive()}
                className="shrink-0 rounded-lg border border-paper-300/70 bg-paper-100/80 px-3 py-1.5 text-xs font-medium text-ink-800 hover:bg-paper-200"
              >
                Regenerate
              </button>
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
                          difficulty {draft.difficulty}
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
                            <input
                              value={labelList(draft.concepts)}
                              onChange={(e) =>
                                updateDraftCard(index, { concepts: parseLabels(e.target.value) })
                              }
                              className={inputClass}
                            />
                          </Field>
                          <Field label="Prerequisites (≤3, comma-separated)">
                            <input
                              value={labelList(draft.prerequisites)}
                              onChange={(e) =>
                                updateDraftCard(index, { prerequisites: parseLabels(e.target.value) })
                              }
                              className={inputClass}
                            />
                          </Field>
                        </div>
                        {draft.kind === 'synthesis' && draft.rubric && (
                          <div className="rounded-xl border border-paper-300/60 bg-paper-100/40 px-3 py-3">
                            <div className="text-xs font-medium uppercase tracking-[0.14em] text-ink-500">
                              Rubric
                            </div>
                            <div className="mt-2 flex flex-col gap-2">
                              {draft.rubric.criteria.map((c, ci) => (
                                <div key={c.id} className="flex items-center gap-2">
                                  <input
                                    value={c.description}
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
                                    onChange={(e) =>
                                      updateCriterion(index, ci, {
                                        weight: Math.max(1, Math.min(3, Number(e.target.value) || 1))
                                      })
                                    }
                                    className={`${inputClass} w-16`}
                                  />
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
                          <blockquote className="border-l-2 border-paper-300 pl-3 text-xs italic text-ink-500">
                            {draft.sourceQuote}
                          </blockquote>
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
          <div className="rounded-2xl border border-paper-300/70 bg-paper-50/50 px-5 py-6 text-sm text-ink-600">
            No cards to review. {dropped > 0 ? `${dropped} card(s) were dropped as invalid. ` : ''}
            <button
              type="button"
              onClick={() => void generateForActive()}
              className="font-medium text-accent underline-offset-2 hover:underline"
            >
              Regenerate
            </button>
          </div>
        )}

        {/* Saved deck (always shown when present, e.g. after save or on revisit). */}
        {savedDeck && savedDeck.cards.length > 0 && (
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
                  <div className="flex items-center gap-2">
                    <CardBadge draft={card} />
                    {card.userEdited && (
                      <span className="text-2xs text-ink-400">edited</span>
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

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-[0.14em] text-ink-500">{label}</span>
      {children}
    </label>
  )
}
