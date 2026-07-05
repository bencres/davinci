import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  useStore,
  FREE_STUDY_DEFAULT_LIMIT,
  STUDY_TIME_BOX_DEFAULT_MS,
  type StudyMode,
  type StudyScope
} from '../store'
import {
  difficultyLabel,
  findSourceQuoteOffset,
  matchRecallAnswer,
  notePathFromStudyTab,
  ratingToNumber,
  recallMatchToRating,
  scoreRubric,
  scoreToRating,
  type Flashcard,
  type FlashcardKind,
  type FsrsRating,
  type GradedCriterion
} from '@shared/flashcards'
import { matchesSequenceToken, getKeymapDisplay } from '../lib/keymaps'
import { isAppOverlayOpen } from '../lib/overlay-open'
import {
  GRADE_FLASH_MS,
  calibrationNote,
  playStudyChime,
  playStudyTick,
  prefersReducedMotion,
  ratingToFeedbackTier,
  type CalibrationNote,
  type FeedbackTier
} from '../lib/study-feedback'
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

/** Effective scope for a launcher when no session is open (idle screen). */
function scopeFor(scope: StudyScope | null, noteScope: string | null): StudyScope {
  return scope ?? (noteScope ? { kind: 'note', notePath: noteScope } : { kind: 'all' })
}

/** Text tone for the post-grade calibration readout (matches the dashboard's
 *  bias colors: over-confident amber, under-confident sky). */
const CALIBRATION_TONE: Record<CalibrationNote['tone'], string> = {
  hit: 'text-emerald-600',
  over: 'text-amber-600',
  under: 'text-sky-600'
}

/** The alternative card-picking modes offered alongside the default due review. */
const MODE_BUTTONS: { mode: StudyMode; label: string; hint: string }[] = [
  { mode: 'weak', label: 'Weak spots', hint: 'Lowest accuracy first' },
  { mode: 'redo', label: 'Redo misses', hint: "Today's again/hard" },
  { mode: 'calibration', label: 'Calibration', hint: 'Where you misjudged' },
  { mode: 'new', label: 'New cards', hint: 'Unseen, ignore cap' },
  { mode: 'free', label: 'Random', hint: 'Shuffle the scope' }
]

/**
 * "More ways to study" — launchers for the alternative modes plus the orthogonal
 * modifiers (card-kind filter, 10-minute time-box, and, for a concept scope,
 * prerequisites / mastery-loop). Rendered on the idle and summary screens; every
 * launch still reschedules graded cards exactly like due review.
 */
function StudyModeMenu({ scope }: { scope: StudyScope }): JSX.Element {
  const startStudySession = useStore((s) => s.startStudySession)
  const [open, setOpen] = useState(false)
  const [cardKind, setCardKind] = useState<FlashcardKind | null>(null)
  const [timeBox, setTimeBox] = useState(false)
  const [withPrereqs, setWithPrereqs] = useState(false)
  const [masteryLoop, setMasteryLoop] = useState(false)
  const isConcept = scope.kind === 'concept'

  const launch = (mode: StudyMode): void => {
    void startStudySession(scope, {
      mode,
      cardKind: cardKind ?? undefined,
      timeBoxMs: timeBox ? STUDY_TIME_BOX_DEFAULT_MS : undefined,
      includePrerequisites: isConcept && withPrereqs ? true : undefined,
      masteryLoop: masteryLoop || undefined,
      limit: mode === 'free' && scope.kind === 'all' ? FREE_STUDY_DEFAULT_LIMIT : undefined
    })
  }

  const toggle = (on: boolean): string =>
    [
      'rounded-full px-2.5 py-1 text-2xs font-medium ring-1 transition',
      on ? 'bg-accent/12 text-accent ring-accent/40' : 'text-ink-500 ring-paper-300/70 hover:ring-accent/40'
    ].join(' ')

  if (!open) {
    return (
      <button
        type="button"
        className="text-xs font-medium text-accent hover:underline"
        onClick={() => setOpen(true)}
      >
        More ways to study…
      </button>
    )
  }

  return (
    <div className="w-full max-w-sm space-y-3 rounded-lg border border-paper-300/70 bg-paper-200/40 p-3 text-left">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-2xs uppercase tracking-[0.12em] text-ink-500">Filter</span>
        <button type="button" className={toggle(cardKind === null)} onClick={() => setCardKind(null)}>
          All
        </button>
        <button
          type="button"
          className={toggle(cardKind === 'recall')}
          onClick={() => setCardKind((k) => (k === 'recall' ? null : 'recall'))}
        >
          Recall
        </button>
        <button
          type="button"
          className={toggle(cardKind === 'synthesis')}
          onClick={() => setCardKind((k) => (k === 'synthesis' ? null : 'synthesis'))}
        >
          Synthesis
        </button>
        <button type="button" className={toggle(timeBox)} onClick={() => setTimeBox((v) => !v)}>
          10-min
        </button>
        {isConcept && (
          <>
            <button
              type="button"
              className={toggle(withPrereqs)}
              onClick={() => setWithPrereqs((v) => !v)}
            >
              + prerequisites
            </button>
            <button
              type="button"
              className={toggle(masteryLoop)}
              onClick={() => setMasteryLoop((v) => !v)}
            >
              Mastery loop
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {MODE_BUTTONS.map((b) => (
          <button
            key={b.mode}
            type="button"
            onClick={() => launch(b.mode)}
            title={b.hint}
            className="rounded-md border border-paper-300/70 bg-paper-100 px-3 py-1.5 text-xs font-medium text-ink-800 hover:border-accent/40 hover:bg-paper-200"
          >
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}

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

/** A circular ring that slowly fills with session progress, the goal in the center. */
function ProgressRing({
  reviewed,
  total,
  reduceMotion
}: {
  reviewed: number
  total: number
  reduceMotion: boolean
}): JSX.Element {
  const radius = 16
  const circumference = 2 * Math.PI * radius
  const pct = total > 0 ? Math.min(1, reviewed / total) : 0
  return (
    <div className="relative h-11 w-11 shrink-0">
      <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90">
        <circle cx="20" cy="20" r={radius} fill="none" stroke="rgb(var(--z-fg) / 0.12)" strokeWidth="3" />
        <circle
          cx="20"
          cy="20"
          r={radius}
          fill="none"
          stroke="rgb(var(--z-accent))"
          strokeWidth="3"
          strokeLinecap="round"
          style={{
            strokeDasharray: circumference,
            strokeDashoffset: circumference * (1 - pct),
            transition: reduceMotion ? undefined : 'stroke-dashoffset 700ms cubic-bezier(0.22, 1, 0.36, 1)'
          }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums text-ink-700">
        {total}
      </span>
    </div>
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
  const studyScope = useStore((s) => s.studyScope)
  const keymapOverrides = useStore((s) => s.keymapOverrides)
  const gamification = useStore((s) => s.studyGamification)

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

  // Transient reveal/grade "feel" state. `nonce` retriggers the celebration
  // animation each grade; it clears itself after the brief flash. Fires on the
  // interaction — never gated by the gradeCurrentCard promise / file write.
  // `calibration` carries the predicted-vs-actual readout for the same window.
  const [feedback, setFeedback] = useState<{
    tier: FeedbackTier
    nonce: number
    calibration: CalibrationNote | null
  } | null>(null)
  const feedbackNonce = useRef(0)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soundEnabled = gamification?.soundEnabled ?? true
  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
  }, [])

  // Predict/rubric toggles and reveal get no card motion — bounce is reserved for
  // the correct-grade pop, and the success circuit is the only card-border effect.

  const rubric = card?.kind === 'synthesis' ? card.rubric : undefined
  const gradedCriteria = useMemo<GradedCriterion[]>(
    () => (rubric ? rubric.criteria.map((c) => ({ criterionId: c.id, met: checked.has(c.id) })) : []),
    [rubric, checked]
  )
  const rubricScore = rubric ? scoreRubric(rubric, gradedCriteria) : 0
  // Tiered auto-check of a typed recall answer (null when nothing was typed).
  const recallMatch =
    card?.kind === 'recall' && answer.trim()
      ? matchRecallAnswer(answer, card.back, card.acceptableAnswers ?? [])
      : null
  // Synthesis suggests from the rubric score; recall from the typed-answer match.
  const suggestedRating: FsrsRating = rubric
    ? scoreToRating(rubricScore)
    : recallMatch
      ? recallMatchToRating(recallMatch)
      : 'good'
  // Whether the flip/Enter keys may confirm `suggestedRating` on a revealed card.
  const canConfirmSuggested = card?.kind === 'synthesis' || recallMatch != null

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
      // Fire the felt response immediately, on the interaction itself — a win
      // (good/easy) gets the amplified beat + optional chime; a soft grade
      // (again/hard) gets a quiet acknowledgement. This is intentionally ahead of
      // (and independent of) the persisted grade below.
      const tier = ratingToFeedbackTier(rating)
      feedbackNonce.current += 1
      setFeedback({ tier, nonce: feedbackNonce.current, calibration: calibrationNote(predicted, rating) })
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current)
      feedbackTimer.current = setTimeout(() => setFeedback(null), GRADE_FLASH_MS)
      if (tier === 'win' && soundEnabled) playStudyChime()

      const detail =
        card.kind === 'synthesis'
          ? { learnerAnswer: answer.trim() || undefined, criteria: gradedCriteria, score: rubricScore }
          : { learnerAnswer: answer.trim() || undefined }
      void gradeCurrentCard(rating, detail)
    },
    [card, answer, predicted, gradedCriteria, rubricScore, gradeCurrentCard, soundEnabled]
  )

  // Reveal: just a soft tick (no card flash).
  const reveal = useCallback(() => {
    if (soundEnabled) playStudyTick()
    revealCurrentCard()
  }, [soundEnabled, revealCurrentCard])

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

      // Digit keys 1–4 always mean "rate": predict before reveal, self-grade
      // after — consistent for both recall and synthesis cards.
      const digit = ([null, 'study.rateAgain', 'study.rateHard', 'study.rateGood', 'study.rateEasy'] as const)
      for (let i = 1; i <= 4; i++) {
        if (seq(digit[i]!)) {
          consume()
          if (phase === 'front') setStudyPredicted(RATINGS[i - 1].id)
          else grade(RATINGS[i - 1].id)
          return
        }
      }

      // Letter keys (a, b, c, …) toggle the matching rubric criterion on a revealed
      // synthesis card — kept off the 1–4 grade keys so they never conflict.
      if (phase === 'revealed' && card?.kind === 'synthesis' && rubric && e.key.length === 1) {
        const idx = e.key.toLowerCase().charCodeAt(0) - 97
        if (idx >= 0 && idx < rubric.criteria.length) {
          consume()
          toggleCriterion(rubric.criteria[idx].id)
          return
        }
      }

      if (seq('study.flip')) {
        consume()
        if (phase === 'front') reveal()
        // After reveal, the flip key confirms the suggested rating (rubric-based
        // on synthesis; typed-answer-based on recall).
        else if (canConfirmSuggested) grade(suggestedRating)
        return
      }
      // Enter confirms the suggested rating on a revealed card with a suggestion.
      if (phase === 'revealed' && canConfirmSuggested && e.key === 'Enter') {
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
    canConfirmSuggested,
    keymapOverrides,
    setStudyPredicted,
    reveal,
    grade,
    toggleCriterion,
    jumpToSource,
    endStudySession
  ])

  // ---- Render -------------------------------------------------------------

  const total = queue.length
  // In-loop progress: `cursor` == grades.length (one advance per grade), so this
  // ticks the instant a card is graded thanks to the optimistic store update.
  const reviewed = grades.length
  const reduceMotion = prefersReducedMotion()
  const showFx = !reduceMotion
  const winNow = showFx && feedback?.tier === 'win'

  if (phase === 'idle') {
    return (
      <StudyShell>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <p className="text-sm text-ink-500">No study session is running.</p>
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
              onClick={() =>
                void startStudySession(noteScope ? { kind: 'note', notePath: noteScope } : { kind: 'all' })
              }
            >
              {noteScope ? 'Study this deck' : 'Review due cards'}
            </button>
            <StudyModeMenu scope={scopeFor(studyScope, noteScope)} />
          </div>
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
    const isRight = (g: (typeof grades)[number]): boolean => g.rating === 'good' || g.rating === 'easy'
    const dist = RATINGS.map((r) => ({
      ...r,
      count: grades.filter((g) => g.rating === r.id).length
    }))
    const correct = grades.filter(isRight).length
    const accuracy = reviewed > 0 ? Math.round((correct / reviewed) * 100) : 0
    // Calibration only means something for cards the learner actually predicted.
    const predictedGrades = grades.filter((g) => g.predictedRating != null)
    const meanError =
      predictedGrades.length > 0
        ? predictedGrades.reduce(
            (a, g) => a + Math.abs(ratingToNumber(g.predictedRating) - ratingToNumber(g.rating)),
            0
          ) / predictedGrades.length
        : 0
    // Session time from grade timestamps (first → last), and a rough per-card avg.
    const times = grades.map((g) => Date.parse(g.reviewedAt)).filter((t) => Number.isFinite(t))
    const elapsedMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : 0
    const fmtDuration = (ms: number): string => {
      const s = Math.round(ms / 1000)
      const m = Math.floor(s / 60)
      return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
    }
    // Per-concept breakdown (focus concept of each reviewed card).
    const byConcept = new Map<string, { total: number; correct: number }>()
    for (const g of grades) {
      const concept = index?.[g.cardId]?.card.concepts[0] ?? '—'
      const e = byConcept.get(concept) ?? { total: 0, correct: 0 }
      e.total++
      if (isRight(g)) e.correct++
      byConcept.set(concept, e)
    }
    const conceptRows = [...byConcept.entries()]
      .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
      .slice(0, 5)
    return (
      <StudyShell>
        <div
          className={`mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5 text-center${
            prefersReducedMotion() ? '' : ' study-card-enter'
          }`}
        >
          <h2 className="text-lg font-semibold text-ink-800">
            {reviewed === 0 ? 'Nothing due right now' : 'Session complete'}
          </h2>
          {studyError && <p className="text-sm text-rose-600">{studyError}</p>}
          {reviewed > 0 && (
            <>
              <p className="text-sm text-ink-500">
                Reviewed <span className="font-medium text-ink-800">{reviewed}</span> card
                {reviewed === 1 ? '' : 's'} ·{' '}
                <span className="font-medium text-ink-800">{accuracy}%</span> correct
                {elapsedMs > 0 && (
                  <>
                    {' '}
                    · <span className="font-medium text-ink-800">{fmtDuration(elapsedMs)}</span>
                  </>
                )}
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
              {predictedGrades.length > 0 && (
                <p className="text-xs text-ink-500">
                  Calibration error (predicted vs. actual):{' '}
                  <span className="font-medium text-ink-800">{meanError.toFixed(2)}</span> / 3 ·{' '}
                  {predictedGrades.length} predicted
                </p>
              )}
              {conceptRows.length > 1 && (
                <div className="w-full text-left">
                  <p className="mb-1.5 text-2xs uppercase tracking-[0.12em] text-ink-500">
                    By concept
                  </p>
                  <ul className="space-y-1">
                    {conceptRows.map(([concept, e]) => (
                      <li key={concept} className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate text-ink-700">{concept}</span>
                        <span className="shrink-0 text-ink-500">
                          {e.correct}/{e.total}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {reviewed === 0 && (
            <p className="text-sm text-ink-500">
              Nothing is scheduled, but you can still practice this scope.
            </p>
          )}
          <button
            type="button"
            className="rounded-md border border-paper-300/70 px-4 py-2 text-sm font-medium text-ink-800 hover:bg-paper-200"
            onClick={() => endStudySession()}
          >
            Done
          </button>
          <StudyModeMenu scope={scopeFor(studyScope, noteScope)} />
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
  // Neighbours for the carousel peeks (may be absent at the ends of the queue).
  const prevCard = cursor > 0 ? index?.[queue[cursor - 1]]?.card : undefined
  const nextCard = index?.[queue[cursor + 1]]?.card

  // Card meta (hidden behind static placeholders until revealed) + the progress
  // ring, shown right-anchored on the action row. Not animated.
  const metaCount = (
    <div className="flex items-center gap-2">
      {revealed ? (
        <>
          <CardBadge card={card} />
          <span className="text-2xs uppercase tracking-[0.12em] text-ink-500">
            {difficultyLabel(card.difficulty)}
          </span>
        </>
      ) : (
        <span className="flex items-center gap-2" aria-hidden>
          <span className="inline-block h-5 w-20 rounded-full bg-paper-300/70" />
          <span className="inline-block h-4 w-12 rounded-full bg-paper-300/70" />
        </span>
      )}
      <ProgressRing reviewed={reviewed} total={total} reduceMotion={reduceMotion} />
    </div>
  )

  // The revealed answer / rubric — rendered INSIDE the card (replacing the
  // question) once the learner submits, not dropped in below.
  const answerContent =
    card.kind === 'recall' ? (
      <div>
        <p className="mb-1 text-2xs uppercase tracking-[0.12em] text-ink-500">Answer</p>
        <p className="whitespace-pre-wrap text-sm text-ink-800">{card.back}</p>
        {card.acceptableAnswers && card.acceptableAnswers.length > 0 && (
          <p className="mt-2 text-xs text-ink-500">Also accepted: {card.acceptableAnswers.join(', ')}</p>
        )}
        {recallMatch != null && (
          <p
            className={`mt-2 text-xs font-medium ${
              recallMatch === 'exact'
                ? 'text-emerald-600'
                : recallMatch === 'close'
                  ? 'text-amber-600'
                  : 'text-rose-600'
            }`}
          >
            {recallMatch === 'exact'
              ? '✓ Your typed answer matched'
              : recallMatch === 'close'
                ? '≈ Close — check the details against the answer'
                : '✗ Your typed answer did not match'}
          </p>
        )}
      </div>
    ) : rubric ? (
      <div>
        <p className="mb-2 text-2xs uppercase tracking-[0.12em] text-ink-500">
          A good answer includes…{' '}
          <span className="ml-1 opacity-70">
            (toggle with a–{String.fromCharCode(96 + rubric.criteria.length)})
          </span>
        </p>
        <ul className="space-y-1.5">
          {rubric.criteria.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => toggleCriterion(c.id)}
                className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left hover:bg-paper-300/40"
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
                  <span className="mr-1 text-2xs font-medium text-ink-500">{String.fromCharCode(97 + i)}.</span>
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
    ) : null

  return (
    <StudyShell>
      {/* Carousel of question cards: the current one in front, neighbours peeking
          behind on either side; advancing rotates the next into view. */}
      <div className="study-carousel mb-5">
        {prevCard && (
          <div className="study-peek study-peek--left" aria-hidden>
            <p className="study-peek-text">{prevCard.front}</p>
          </div>
        )}
        {nextCard && (
          <div className="study-peek study-peek--right" aria-hidden>
            <p className="study-peek-text">{nextCard.front}</p>
          </div>
        )}
        <div className="study-card-frame">
          {/* Win circuit overlay — pointer-none, keyed so it replays per grade. */}
          {winNow && (
            <svg key={`circ-${feedback!.nonce}`} aria-hidden className="study-card-overlay study-card-circuit">
              <rect x="0" y="0" width="100%" height="100%" rx="15" pathLength={100} />
            </svg>
          )}
          {/* Outer layer carries the win pop; inner rotates the card into view. */}
          <div key={`pop-${cardId}`} className={winNow ? 'study-card--pop' : undefined}>
            <div className={showFx ? 'study-card-rotate-in' : undefined}>
              <div className="study-question rounded-xl border border-paper-300/70 bg-paper-200 p-5 shadow-md">
                {/* Keyed by phase so question↔answer swap plays the quick flip. */}
                <div key={revealed ? 'answer' : 'question'} className={showFx ? 'study-card-swap' : undefined}>
                  {revealed ? (
                    answerContent
                  ) : (
                    <p className="whitespace-pre-wrap text-sm text-ink-800">{card.front}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Calibration readout for the just-graded card — a fixed-height slot so
          the flash never shifts layout. Static text, so it shows (and reads via
          aria-live) even when motion is reduced. */}
      <div className="h-4 text-center text-xs font-medium" aria-live="polite">
        {feedback?.calibration && (
          <span className={CALIBRATION_TONE[feedback.calibration.tone]}>
            {feedback.calibration.text}
          </span>
        )}
      </div>

      {/* Answer + grading controls (operate on the current card). */}
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
            Predict how you'll do (optional calibration)
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
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => reveal()}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
            >
              Reveal <span className="ml-1 opacity-70">{getKeymapDisplay(keymapOverrides, 'study.flip')}</span>
            </button>
            {metaCount}
          </div>
        </div>
      )}

      {/* Revealed: grade controls (the answer itself is shown in the card above). */}
      {revealed && (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-end">{metaCount}</div>
          {predicted && (
            <p className="text-2xs uppercase tracking-[0.12em] text-ink-500">
              You predicted: <span className="font-medium text-ink-800">{predicted}</span>
            </p>
          )}

          {/* Grade buttons */}
          <div>
            <p className="mb-2 text-2xs uppercase tracking-[0.12em] text-ink-500">
              {canConfirmSuggested
                ? 'Grade 1–4 (or Enter for the suggestion)'
                : 'How well did you recall it? (1–4)'}
            </p>
            <div className="flex flex-wrap gap-2">
              {RATINGS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => grade(r.id)}
                  className={[
                    'rounded-md px-3 py-1.5 text-xs font-medium ring-1 transition',
                    canConfirmSuggested && suggestedRating === r.id
                      ? r.tone
                      : 'bg-paper-200/50 text-ink-500 ring-paper-300/70 hover:ring-accent/40'
                  ].join(' ')}
                >
                  <span className="mr-1 opacity-60">{r.key}</span>
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

/** Shared chrome: a centered, scrollable column. `overlay` (when given) frames
 *  the whole pane — its edges — above the scrolling content. */
function StudyShell({ children, overlay }: { children: ReactNode; overlay?: ReactNode }): JSX.Element {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-paper-100">
      {overlay}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 py-8">{children}</div>
      </div>
    </div>
  )
}
