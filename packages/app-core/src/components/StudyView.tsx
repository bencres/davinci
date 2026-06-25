import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import {
  checkRecallAnswer,
  difficultyLabel,
  findSourceQuoteOffset,
  isStudyTabPath,
  notePathFromStudyTab,
  scoreRubric,
  scoreToRating,
  type Flashcard,
  type FsrsRating,
  type GradedCriterion
} from '@shared/flashcards'
import { matchesSequenceToken } from '../lib/keymaps'
import { isAppOverlayOpen } from '../lib/overlay-open'
import { ArrowUpRightIcon } from './icons'

interface Props {
  tabPath: string
  isActive: boolean
}

/** The four FSRS ratings, in 1–4 key order, with display metadata. */
const RATINGS: { id: FsrsRating; label: string; key: string; tone: string }[] = [
  { id: 'again', label: 'Again', key: '1', tone: 'bg-rose-500/12 text-rose-700 ring-rose-500/30' },
  { id: 'hard', label: 'Hard', key: '2', tone: 'bg-amber-500/12 text-amber-700 ring-amber-500/30' },
  { id: 'good', label: 'Good', key: '3', tone: 'bg-sky-500/12 text-sky-700 ring-sky-500/30' },
  { id: 'easy', label: 'Easy', key: '4', tone: 'bg-emerald-500/12 text-emerald-700 ring-emerald-500/30' }
]
const RATING_NUM: Record<FsrsRating, number> = { again: 1, hard: 2, good: 3, easy: 4 }

function CardBadge({ card }: { card: Flashcard }): JSX.Element {
  const recall = card.kind === 'recall'
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium uppercase tracking-[0.12em]',
        recall ? 'bg-sky-500/12 text-sky-700' : 'bg-violet-500/12 text-violet-700'
      ].join(' ')}
    >
      {card.kind} · {card.subtype}
    </span>
  )
}

export function StudyView({ tabPath, isActive }: Props): JSX.Element {
  const noteScope = useMemo(() => notePathFromStudyTab(tabPath), [tabPath])

  const phase = useStore((s) => s.studyPhase)
  const index = useStore((s) => s.studyIndex)
  const queue = useStore((s) => s.studyQueue)
  const cursor = useStore((s) => s.studyCursor)
  const predicted = useStore((s) => s.studyPredicted)
  const grades = useStore((s) => s.studySessionGrades)
  const studyError = useStore((s) => s.studyError)
  const keymapOverrides = useStore((s) => s.keymapOverrides)

  const startStudySession = useStore((s) => s.startStudySession)
  const setStudyPredicted = useStore((s) => s.setStudyPredicted)
  const revealCurrentCard = useStore((s) => s.revealCurrentCard)
  const gradeCurrentCard = useStore((s) => s.gradeCurrentCard)
  const endStudySession = useStore((s) => s.endStudySession)
  const openNoteAtOffset = useStore((s) => s.openNoteAtOffset)
  const selectNote = useStore((s) => s.selectNote)

  const cardId = queue[cursor]
  const entry = index && cardId ? index[cardId] : undefined
  const card = entry?.card
  const notePath = entry?.sourceNotePath ?? null

  // Per-card local state: the learner's typed answer + which rubric bullets they
  // checked. Reset whenever we advance to a new card.
  const [answer, setAnswer] = useState('')
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setAnswer('')
    setChecked(new Set())
  }, [cardId])

  const rubric = card?.kind === 'synthesis' ? card.rubric : undefined
  const gradedCriteria = useMemo<GradedCriterion[]>(
    () => (rubric ? rubric.criteria.map((c) => ({ criterionId: c.id, met: checked.has(c.id) })) : []),
    [rubric, checked]
  )
  const rubricScore = rubric ? scoreRubric(rubric, gradedCriteria) : 0
  const suggestedRating = rubric ? scoreToRating(rubricScore) : 'good'

  const jumpToSource = useCallback(async () => {
    if (!notePath || !card) return
    let body = useStore.getState().noteContents[notePath]?.body
    if (body == null) {
      try {
        body = (await window.zen.readNote(notePath)).body
      } catch {
        body = ''
      }
    }
    const offset = card.sourceQuote ? findSourceQuoteOffset(body ?? '', card.sourceQuote) : null
    if (offset != null) await openNoteAtOffset(notePath, offset, { scrollMode: 'center' })
    else await selectNote(notePath)
  }, [notePath, card, openNoteAtOffset, selectNote])

  const grade = useCallback(
    (rating: FsrsRating) => {
      if (!card) return
      const detail =
        card.kind === 'synthesis'
          ? { learnerAnswer: answer.trim() || undefined, criteria: gradedCriteria, score: rubricScore }
          : { learnerAnswer: answer.trim() || undefined }
      void gradeCurrentCard(rating, detail)
    },
    [card, answer, gradedCriteria, rubricScore, gradeCurrentCard]
  )

  const toggleCriterion = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Keyboard — study-session bindings (rebindable; respect text fields).
  useEffect(() => {
    if (!isActive || (phase !== 'front' && phase !== 'revealed')) return
    const handler = (e: KeyboardEvent): void => {
      if (isAppOverlayOpen()) return
      const active = document.activeElement as HTMLElement | null
      const inField =
        !!active &&
        (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)

      const consume = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      if (e.key === 'Escape') {
        if (inField) {
          consume()
          active?.blur?.()
        } else {
          consume()
          endStudySession()
        }
        return
      }
      // Remaining single-key bindings only apply outside text fields.
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return
      const seq = (id: Parameters<typeof matchesSequenceToken>[2]): boolean =>
        matchesSequenceToken(e, keymapOverrides, id)

      if (seq('study.jumpSource')) {
        consume()
        void jumpToSource()
        return
      }

      // Digit keys: predict before reveal; grade (recall) or toggle rubric
      // bullets (synthesis) after reveal.
      const digit = ([null, 'study.rateAgain', 'study.rateHard', 'study.rateGood', 'study.rateEasy'] as const)
      for (let i = 1; i <= 4; i++) {
        if (seq(digit[i]!)) {
          consume()
          if (phase === 'front') {
            setStudyPredicted(RATINGS[i - 1].id)
          } else if (card?.kind === 'synthesis') {
            const crit = rubric?.criteria[i - 1]
            if (crit) toggleCriterion(crit.id)
          } else {
            grade(RATINGS[i - 1].id)
          }
          return
        }
      }

      if (seq('study.flip')) {
        consume()
        if (phase === 'front') revealCurrentCard()
        // After reveal, Space confirms the suggested rating on synthesis cards.
        else if (card?.kind === 'synthesis') grade(suggestedRating)
        return
      }
      // `g`/Enter confirm the suggested rating on a revealed synthesis card.
      if (phase === 'revealed' && card?.kind === 'synthesis' && (e.key === 'g' || e.key === 'Enter')) {
        consume()
        grade(suggestedRating)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    isActive,
    phase,
    card,
    rubric,
    suggestedRating,
    keymapOverrides,
    setStudyPredicted,
    revealCurrentCard,
    grade,
    toggleCriterion,
    jumpToSource,
    endStudySession
  ])

  // ---- Render -------------------------------------------------------------

  const total = queue.length
  const position = Math.min(cursor + 1, total)

  if (phase === 'idle') {
    return (
      <StudyShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-ink-500">No study session is running.</p>
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
            onClick={() =>
              void startStudySession(noteScope ? { kind: 'note', notePath: noteScope } : { kind: 'all' })
            }
          >
            {noteScope ? 'Study this deck' : 'Review due cards'}
          </button>
        </div>
      </StudyShell>
    )
  }

  if (phase === 'loading') {
    return (
      <StudyShell>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          Loading due cards…
        </div>
      </StudyShell>
    )
  }

  if (phase === 'summary') {
    const reviewed = grades.length
    const dist = RATINGS.map((r) => ({
      ...r,
      count: grades.filter((g) => g.rating === r.id).length
    }))
    const calibrationErrors = grades.map((g) => Math.abs(RATING_NUM[g.predictedRating] - RATING_NUM[g.rating]))
    const meanError =
      calibrationErrors.length > 0
        ? calibrationErrors.reduce((a, b) => a + b, 0) / calibrationErrors.length
        : 0
    return (
      <StudyShell>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 text-center">
          <h2 className="text-lg font-semibold text-ink-800">
            {reviewed === 0 ? 'Nothing due right now' : 'Session complete'}
          </h2>
          {studyError && <p className="text-sm text-rose-600">{studyError}</p>}
          {reviewed > 0 && (
            <>
              <p className="text-sm text-ink-500">
                Reviewed <span className="font-medium text-ink-800">{reviewed}</span> card
                {reviewed === 1 ? '' : 's'}.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {dist.map((d) => (
                  <span
                    key={d.id}
                    className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${d.tone}`}
                  >
                    {d.label}: {d.count}
                  </span>
                ))}
              </div>
              <p className="text-xs text-ink-500">
                Calibration error (predicted vs. actual):{' '}
                <span className="font-medium text-ink-800">{meanError.toFixed(2)}</span> / 3
              </p>
            </>
          )}
          <button
            type="button"
            className="rounded-md border border-paper-300/70 px-4 py-2 text-sm font-medium text-ink-800 hover:bg-paper-200"
            onClick={() => endStudySession()}
          >
            Done
          </button>
        </div>
      </StudyShell>
    )
  }

  if (!card) {
    return (
      <StudyShell>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          No card to show.
        </div>
      </StudyShell>
    )
  }

  const revealed = phase === 'revealed'
  const recallCorrect =
    card.kind === 'recall' && answer.trim()
      ? checkRecallAnswer(answer, card.back, card.acceptableAnswers ?? [])
      : null

  return (
    <StudyShell>
      {/* Progress + meta */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardBadge card={card} />
          <span className="text-2xs uppercase tracking-[0.12em] text-ink-500">
            {difficultyLabel(card.difficulty)}
          </span>
        </div>
        <span className="text-xs text-ink-500">
          {position} / {total}
        </span>
      </div>

      {/* Front */}
      <div className="rounded-lg border border-paper-300/70 bg-paper-200/50 p-4">
        <p className="whitespace-pre-wrap text-sm text-ink-800">{card.front}</p>
      </div>

      {/* Answer input */}
      <div className="mt-4">
        <label className="mb-1 block text-2xs uppercase tracking-[0.12em] text-ink-500">
          {card.kind === 'synthesis' ? 'Your answer' : 'Your answer (optional)'}
        </label>
        <textarea
          className="min-h-[72px] w-full resize-y rounded-md border border-paper-300/70 bg-paper-100 px-3 py-2 text-sm text-ink-800 outline-none focus:border-accent"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={card.kind === 'synthesis' ? 'Write your answer, then reveal the rubric.' : 'Type to self-test, then reveal.'}
          disabled={revealed}
        />
      </div>

      {/* Predict (front only) */}
      {!revealed && (
        <div className="mt-4">
          <p className="mb-2 text-2xs uppercase tracking-[0.12em] text-ink-500">
            Predict how you'll do (calibration)
          </p>
          <div className="flex flex-wrap gap-2">
            {RATINGS.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setStudyPredicted(r.id)}
                className={[
                  'rounded-md px-3 py-1.5 text-xs font-medium ring-1 transition',
                  predicted === r.id ? r.tone : 'bg-paper-200/50 text-ink-500 ring-paper-300/70 hover:ring-accent/40'
                ].join(' ')}
              >
                <span className="mr-1 opacity-60">{r.key}</span>
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => revealCurrentCard()}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Reveal <span className="ml-1 opacity-70">Space</span>
          </button>
        </div>
      )}

      {/* Revealed: answer + grading */}
      {revealed && (
        <div className="mt-4 space-y-4">
          {predicted && (
            <p className="text-2xs uppercase tracking-[0.12em] text-ink-500">
              You predicted: <span className="font-medium text-ink-800">{predicted}</span>
            </p>
          )}

          {card.kind === 'recall' ? (
            <div className="rounded-lg border border-paper-300/70 bg-emerald-500/5 p-4">
              <p className="mb-1 text-2xs uppercase tracking-[0.12em] text-ink-500">Answer</p>
              <p className="whitespace-pre-wrap text-sm text-ink-800">{card.back}</p>
              {card.acceptableAnswers && card.acceptableAnswers.length > 0 && (
                <p className="mt-2 text-xs text-ink-500">
                  Also accepted: {card.acceptableAnswers.join(', ')}
                </p>
              )}
              {recallCorrect != null && (
                <p className={`mt-2 text-xs font-medium ${recallCorrect ? 'text-emerald-600' : 'text-rose-600'}`}>
                  {recallCorrect ? '✓ Your typed answer matched' : '✗ Your typed answer did not match'}
                </p>
              )}
            </div>
          ) : (
            rubric && (
              <div className="rounded-lg border border-paper-300/70 bg-violet-500/5 p-4">
                <p className="mb-2 text-2xs uppercase tracking-[0.12em] text-ink-500">
                  A good answer includes… <span className="ml-1 opacity-70">(toggle with 1–{rubric.criteria.length})</span>
                </p>
                <ul className="space-y-1.5">
                  {rubric.criteria.map((c, i) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => toggleCriterion(c.id)}
                        className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-paper-200/70"
                      >
                        <span
                          className={[
                            'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border text-2xs',
                            checked.has(c.id)
                              ? 'border-emerald-500 bg-emerald-500 text-white'
                              : 'border-paper-300/70 text-transparent'
                          ].join(' ')}
                        >
                          ✓
                        </span>
                        <span className="text-sm text-ink-800">
                          <span className="mr-1 text-2xs text-ink-500">{i + 1}.</span>
                          {c.description}
                          <span className="ml-1 text-2xs text-ink-500">(×{c.weight})</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 border-t border-paper-300/70 pt-3">
                  <p className="mb-1 text-2xs uppercase tracking-[0.12em] text-ink-500">Model answer</p>
                  <p className="whitespace-pre-wrap text-sm text-ink-800">{rubric.modelAnswer}</p>
                </div>
                {rubric.misconceptions && rubric.misconceptions.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1 text-2xs uppercase tracking-[0.12em] text-ink-500">Watch out for</p>
                    <ul className="list-disc pl-5 text-xs text-ink-500">
                      {rubric.misconceptions.map((m, i) => (
                        <li key={i}>{m}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="mt-3 text-xs text-ink-500">
                  Score <span className="font-medium text-ink-800">{Math.round(rubricScore * 100)}%</span> → suggested{' '}
                  <span className="font-medium text-ink-800">{suggestedRating}</span>
                </p>
              </div>
            )
          )}

          {/* Grade buttons */}
          <div>
            <p className="mb-2 text-2xs uppercase tracking-[0.12em] text-ink-500">
              {card.kind === 'synthesis' ? 'Grade (or press g for the suggestion)' : 'How well did you recall it?'}
            </p>
            <div className="flex flex-wrap gap-2">
              {RATINGS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => grade(r.id)}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-medium ring-1 transition',
                    card.kind === 'synthesis' && suggestedRating === r.id
                      ? r.tone
                      : 'bg-paper-200/50 text-ink-500 ring-paper-300/70 hover:ring-accent/40'
                  ].join(' ')}
                >
                  {card.kind === 'recall' && <span className="mr-1 opacity-60">{r.key}</span>}
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {card.sourceQuote && (
            <button
              type="button"
              onClick={() => void jumpToSource()}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            >
              Source <ArrowUpRightIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </StudyShell>
  )
}

/** Shared chrome: a centered, scrollable column. */
function StudyShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-paper-100">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-8">{children}</div>
    </div>
  )
}

export { isStudyTabPath }
