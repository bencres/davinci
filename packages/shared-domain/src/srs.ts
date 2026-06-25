/**
 * SRS scheduling adapter + due-queue selection.
 *
 * This module is PURE (no node/DOM/third-party imports) so it is shared by the
 * main process, the renderer, and the web bridge — exactly like flashcards.ts.
 * The actual FSRS math lives in the `ts-fsrs` library, which must NOT be
 * imported here (it would break shared-domain's zero-dependency invariant).
 * Instead this file provides the lossless conversion between our persisted
 * `SrsState` and the plain-object card shape `ts-fsrs` consumes/returns, plus
 * the pure due-queue selection logic. The single `ts-fsrs` binding lives in
 * `packages/app-core/src/lib/srs-scheduler.ts`, which calls `schedule()`.
 *
 * Scheduler config note: we run FSRS with short-term (intraday) learning steps
 * DISABLED (`enable_short_term: false`, set in the binding). Cards therefore
 * move New → Review directly at day-scale intervals, so every field FSRS needs
 * round-trips losslessly through `SrsState` (which has no learning-step
 * counter). Anki-style 1m/10m learning steps can be added later behind a new
 * model field without changing this module's contract.
 */

import type { Flashcard, SrsState } from './flashcards'

// ts-fsrs State enum order: New=0, Learning=1, Review=2, Relearning=3.
export type FsrsStateName = 'New' | 'Learning' | 'Review' | 'Relearning'

/**
 * Structural shape of a ts-fsrs card INPUT (matches its `CardInput`), expressed
 * as plain data so this module imports nothing. ISO strings are valid `DateInput`s.
 */
export interface FsrsCardShape {
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: FsrsStateName
  last_review?: string | null
}

/** Structural shape of a ts-fsrs RESULT card we read back (Date-or-string tolerant). */
export interface FsrsResultCard {
  due: Date | string | number
  stability: number
  difficulty: number
  reps: number
  lapses: number
  state: number | FsrsStateName
  last_review?: Date | string | number | null
}

const SRS_TO_FSRS_STATE: Record<SrsState['state'], FsrsStateName> = {
  new: 'New',
  learning: 'Learning',
  review: 'Review',
  relearning: 'Relearning'
}

const FSRS_STATE_BY_NUM: Record<number, SrsState['state']> = {
  0: 'new',
  1: 'learning',
  2: 'review',
  3: 'relearning'
}

const FSRS_STATE_BY_NAME: Record<FsrsStateName, SrsState['state']> = {
  New: 'new',
  Learning: 'learning',
  Review: 'review',
  Relearning: 'relearning'
}

function toIso(value: Date | string | number | null | undefined, fallback: string): string {
  if (value == null) return fallback
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') return new Date(value).toISOString()
  return value
}

/**
 * Convert our persisted `SrsState` into the plain card shape ts-fsrs consumes.
 * A never-scheduled card (`state:'new'` / `due:null`) becomes a fresh New card
 * due `now` with zeroed stability/difficulty (ts-fsrs computes the real initial
 * values from its parameters on the first grade, ignoring these zeros).
 */
export function srsToFsrsCard(srs: SrsState, now: Date): FsrsCardShape {
  const nowIso = now.toISOString()
  const fresh = srs.state === 'new' || srs.due == null
  return {
    due: fresh ? nowIso : toIso(srs.due, nowIso),
    stability: srs.stability ?? 0,
    difficulty: srs.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: srs.reps,
    lapses: srs.lapses,
    state: SRS_TO_FSRS_STATE[srs.state] ?? 'New',
    last_review: srs.lastReview ?? undefined
  }
}

/**
 * Convert a ts-fsrs result card back into our persisted `SrsState`. `now` (the
 * review instant) is the fallback for `lastReview` when the result omits it.
 */
export function fsrsCardToSrs(card: FsrsResultCard, now: Date): SrsState {
  const nowIso = now.toISOString()
  const state =
    typeof card.state === 'number'
      ? FSRS_STATE_BY_NUM[card.state] ?? 'review'
      : FSRS_STATE_BY_NAME[card.state] ?? 'review'
  return {
    state,
    due: toIso(card.due, nowIso),
    stability: typeof card.stability === 'number' ? card.stability : null,
    difficulty: typeof card.difficulty === 'number' ? card.difficulty : null,
    reps: card.reps,
    lapses: card.lapses,
    lastReview: toIso(card.last_review, nowIso)
  }
}

// ---------------------------------------------------------------------------
// Due-queue selection (pure).
// ---------------------------------------------------------------------------

/** A new card has never been scheduled. */
export function isNew(srs: SrsState): boolean {
  return srs.state === 'new' || srs.due == null
}

/** A non-new card whose `due` has arrived (relative to `nowMs`). */
export function isDue(srs: SrsState, nowMs: number): boolean {
  if (isNew(srs)) return false
  if (srs.due == null) return false
  const due = Date.parse(srs.due)
  return Number.isFinite(due) && due <= nowMs
}

export interface CardIndexEntry {
  card: Flashcard
  sourceNotePath: string
}
export type CardIndex = Record<string, CardIndexEntry>

export interface DueQueueOptions {
  now?: Date
  /** Max NEW cards to introduce (after subtracting `newDoneToday`). Default Infinity. */
  newPerDay?: number
  /** Max REVIEW-state cards to schedule (after `reviewsDoneToday`). Default Infinity. */
  maxReviewsPerDay?: number
  newDoneToday?: number
  reviewsDoneToday?: number
}

function byIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Build the ordered study queue across all decks: learning/relearning cards
 * that are due (time-sensitive, never capped) first, then due reviews (capped
 * by the daily review limit), then new cards (capped by the daily new limit).
 * Deterministic (due asc then id; new by createdAt asc then id) for stable tests.
 */
export function selectDueQueue(index: CardIndex, opts: DueQueueOptions = {}): string[] {
  const nowMs = (opts.now ?? new Date()).getTime()

  const learning: Array<{ id: string; due: number }> = []
  const reviews: Array<{ id: string; due: number }> = []
  const news: Array<{ id: string; createdAt: number }> = []

  for (const [id, entry] of Object.entries(index)) {
    const srs = entry.card.srs
    if (isNew(srs)) {
      news.push({ id, createdAt: entry.card.createdAt })
    } else if (isDue(srs, nowMs)) {
      const due = srs.due ? Date.parse(srs.due) : nowMs
      if (srs.state === 'learning' || srs.state === 'relearning') learning.push({ id, due })
      else reviews.push({ id, due })
    }
  }

  learning.sort((a, b) => a.due - b.due || byIdAsc(a.id, b.id))
  reviews.sort((a, b) => a.due - b.due || byIdAsc(a.id, b.id))
  news.sort((a, b) => a.createdAt - b.createdAt || byIdAsc(a.id, b.id))

  const reviewBudget = Math.max(0, (opts.maxReviewsPerDay ?? Infinity) - (opts.reviewsDoneToday ?? 0))
  const newBudget = Math.max(0, (opts.newPerDay ?? Infinity) - (opts.newDoneToday ?? 0))

  return [
    ...learning.map((x) => x.id),
    ...reviews.slice(0, reviewBudget).map((x) => x.id),
    ...news.slice(0, newBudget).map((x) => x.id)
  ]
}

// ---------------------------------------------------------------------------
// Session shaping (pure): warm-up, interleaving, cooldown.
// ---------------------------------------------------------------------------

export interface SessionShapeOptions {
  /** Easy cards to front-load for momentum (default 2). */
  warmupCount?: number
  /** Easy cards to reserve for the end (default 2). */
  cooldownCount?: number
  /** Spread consecutive cards across different focus concepts (default true). */
  interleave?: boolean
}

const DEFAULT_WARMUP = 2
const DEFAULT_COOLDOWN = 2

/** Easier cards first: lower card difficulty, then higher FSRS stability. */
function easeCompare(a: Flashcard | undefined, b: Flashcard | undefined): number {
  const da = a?.difficulty ?? 2
  const db = b?.difficulty ?? 2
  if (da !== db) return da - db
  return (b?.srs.stability ?? 0) - (a?.srs.stability ?? 0)
}

/** Normalized focus concept (concepts[0]) used to spread cards during interleaving. */
function focusConceptKey(card: Flashcard | undefined): string {
  return (card?.concepts[0] ?? '').trim().toLowerCase()
}

/**
 * Reorder so consecutive cards avoid the same focus concept where possible.
 * Greedy: repeatedly take from the largest remaining concept bucket whose key
 * differs from the previous pick (falling back to the only bucket left).
 * Deterministic — buckets keep first-seen insertion order to break ties.
 */
function interleaveByConcept(ids: string[], cardOf: (id: string) => Flashcard | undefined): string[] {
  if (ids.length <= 2) return ids
  const buckets = new Map<string, string[]>()
  for (const id of ids) {
    const k = focusConceptKey(cardOf(id))
    const b = buckets.get(k)
    if (b) b.push(id)
    else buckets.set(k, [id])
  }
  if (buckets.size <= 1) return ids

  const result: string[] = []
  let lastKey: string | null = null
  for (let n = ids.length; n > 0; n--) {
    let chosen: string | null = null
    let best = -1
    for (const [k, b] of buckets) {
      if (b.length === 0 || k === lastKey) continue
      if (b.length > best) {
        best = b.length
        chosen = k
      }
    }
    if (chosen == null) {
      for (const [k, b] of buckets) {
        if (b.length > 0) {
          chosen = k
          break
        }
      }
    }
    if (chosen == null) break
    result.push(buckets.get(chosen)!.shift()!)
    lastKey = chosen
  }
  return result
}

/**
 * Shape a due queue (from `selectDueQueue`) into a session: due learning/
 * relearning cards stay first (time-sensitive), then an easy warm-up, then the
 * harder middle interleaved across concepts, then an easy cool-down to finish
 * on confidence. Falls back to a plain (optionally interleaved) order when the
 * queue is too small to sandwich.
 */
export function shapeSession(
  orderedIds: string[],
  index: CardIndex,
  opts: SessionShapeOptions = {}
): string[] {
  const warmupCount = Math.max(0, opts.warmupCount ?? DEFAULT_WARMUP)
  const cooldownCount = Math.max(0, opts.cooldownCount ?? DEFAULT_COOLDOWN)
  const interleave = opts.interleave ?? true
  const cardOf = (id: string): Flashcard | undefined => index[id]?.card

  // Lead: due learning/relearning cards stay first, in their given order.
  const lead: string[] = []
  const rest: string[] = []
  for (const id of orderedIds) {
    const st = cardOf(id)?.srs.state
    if (st === 'learning' || st === 'relearning') lead.push(id)
    else rest.push(id)
  }

  // Too small to sandwich a distinct middle → just (optionally) interleave.
  if (rest.length < warmupCount + cooldownCount + 2) {
    return [...lead, ...(interleave ? interleaveByConcept(rest, cardOf) : rest)]
  }

  // Pick the easiest cards for the warm-up and cool-down ends.
  const byEase = [...rest].sort((a, b) => easeCompare(cardOf(a), cardOf(b)))
  const warmup = byEase.slice(0, warmupCount)
  const cooldown = byEase.slice(warmupCount, warmupCount + cooldownCount)
  const picked = new Set([...warmup, ...cooldown])
  const middleIds = rest.filter((id) => !picked.has(id)) // preserve due order
  const middle = interleave ? interleaveByConcept(middleIds, cardOf) : middleIds

  return [...lead, ...warmup, ...middle, ...cooldown]
}

/** Split the index into never-scheduled vs currently-due ids (for summaries/counts). */
export function splitNewVsReview(
  index: CardIndex,
  now: Date = new Date()
): { newIds: string[]; dueIds: string[] } {
  const nowMs = now.getTime()
  const newIds: string[] = []
  const dueIds: string[] = []
  for (const [id, entry] of Object.entries(index)) {
    if (isNew(entry.card.srs)) newIds.push(id)
    else if (isDue(entry.card.srs, nowMs)) dueIds.push(id)
  }
  return { newIds, dueIds }
}
