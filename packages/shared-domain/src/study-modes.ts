/**
 * Log-driven study-mode selectors (pure). These build a session queue from the
 * card index plus the review history — the part that needs `ReviewLogFile`, kept
 * out of `srs.ts` so that module stays history-free. Each returns an ordered
 * list of cardIds; the store shapes/runs it like any other queue.
 *
 * All three reschedule cards through FSRS when graded, exactly like due/free
 * study — they only change *which* cards (and in what order) you practice.
 */

import { ratingToNumber, type ReviewGrade, type ReviewLogFile } from './flashcards'
import type { CardIndex } from './srs'

/** Group every logged grade by cardId, keeping only cards present in `index`. */
function gradesByCard(index: CardIndex, logs: ReviewLogFile[]): Map<string, ReviewGrade[]> {
  const byCard = new Map<string, ReviewGrade[]>()
  for (const log of logs) {
    for (const g of log.grades) {
      if (!index[g.cardId]) continue
      const list = byCard.get(g.cardId)
      if (list) list.push(g)
      else byCard.set(g.cardId, [g])
    }
  }
  return byCard
}

function byIdAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function applyLimit(ids: string[], limit?: number): string[] {
  return limit != null && limit >= 0 ? ids.slice(0, limit) : ids
}

/** A grade counts as a "miss" — the cards a learner most wants to redo. */
function isMiss(rating: ReviewGrade['rating']): boolean {
  return rating === 'again' || rating === 'hard'
}

export interface WeakCardsOptions {
  /** Cap the queue length (default: no cap). */
  limit?: number
}

/**
 * Rank the cards you struggle with most: lowest review accuracy first, then more
 * lapses, then lower FSRS stability. Never-reviewed cards are excluded (no
 * evidence of weakness — use new-card study for those). Deterministic by id.
 */
export function rankWeakCards(
  index: CardIndex,
  logs: ReviewLogFile[],
  opts: WeakCardsOptions = {}
): string[] {
  const byCard = gradesByCard(index, logs)
  const scored: Array<{ id: string; accuracy: number; lapses: number; stability: number }> = []
  for (const [id, grades] of byCard) {
    if (grades.length === 0) continue
    const right = grades.filter((g) => g.rating === 'good' || g.rating === 'easy').length
    const srs = index[id]!.card.srs
    scored.push({
      id,
      accuracy: right / grades.length,
      lapses: srs.lapses ?? 0,
      stability: srs.stability ?? 0
    })
  }
  scored.sort(
    (a, b) =>
      a.accuracy - b.accuracy ||
      b.lapses - a.lapses ||
      a.stability - b.stability ||
      byIdAsc(a.id, b.id)
  )
  return applyLimit(scored.map((x) => x.id), opts.limit)
}

export interface RecentMissesOptions {
  now?: Date
  /**
   * How far back a miss still counts, in ms. Default: since local midnight
   * ("today's misses").
   */
  withinMs?: number
  limit?: number
}

/** Local-midnight timestamp for `d` (start of that calendar day). */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * Cards graded `again`/`hard` recently (default: today) — for a quick "redo my
 * misses" pass. Ordered by most-recent miss first. Deterministic by id on ties.
 */
export function selectRecentMisses(
  index: CardIndex,
  logs: ReviewLogFile[],
  opts: RecentMissesOptions = {}
): string[] {
  const now = opts.now ?? new Date()
  const nowMs = now.getTime()
  const withinMs = opts.withinMs ?? nowMs - startOfLocalDay(now)
  const byCard = gradesByCard(index, logs)
  const scored: Array<{ id: string; lastMissMs: number }> = []
  for (const [id, grades] of byCard) {
    let lastMissMs = -Infinity
    for (const g of grades) {
      if (!isMiss(g.rating)) continue
      const t = Date.parse(g.reviewedAt)
      if (Number.isFinite(t) && nowMs - t <= withinMs && t > lastMissMs) lastMissMs = t
    }
    if (lastMissMs > -Infinity) scored.push({ id, lastMissMs })
  }
  scored.sort((a, b) => b.lastMissMs - a.lastMissMs || byIdAsc(a.id, b.id))
  return applyLimit(scored.map((x) => x.id), opts.limit)
}

export interface MiscalibratedOptions {
  /** Minimum mean |predicted − actual| (1–4 scale) to include. Default 1.0. */
  threshold?: number
  limit?: number
}

/**
 * Cards where your pre-reveal prediction diverged most from how you actually
 * graded — calibration training. Mean |predicted − actual| on the 1–4 scale,
 * worst first. Cards below `threshold` (well-calibrated) are excluded.
 */
export function selectMiscalibratedCards(
  index: CardIndex,
  logs: ReviewLogFile[],
  opts: MiscalibratedOptions = {}
): string[] {
  const threshold = opts.threshold ?? 1.0
  const byCard = gradesByCard(index, logs)
  const scored: Array<{ id: string; error: number }> = []
  for (const [id, grades] of byCard) {
    let sum = 0
    let n = 0
    for (const g of grades) {
      if (g.predictedRating == null) continue // no prediction → says nothing about calibration
      const diff = Math.abs(ratingToNumber(g.predictedRating) - ratingToNumber(g.rating))
      if (Number.isFinite(diff)) {
        sum += diff
        n++
      }
    }
    if (n === 0) continue
    const error = sum / n
    if (error >= threshold) scored.push({ id, error })
  }
  scored.sort((a, b) => b.error - a.error || byIdAsc(a.id, b.id))
  return applyLimit(scored.map((x) => x.id), opts.limit)
}
