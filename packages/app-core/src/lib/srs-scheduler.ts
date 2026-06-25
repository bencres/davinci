/**
 * The single `ts-fsrs` binding. Everything else in the study loop stays pure;
 * this thin module converts our `SrsState` to the FSRS card shape (via the pure
 * `@shared/srs` adapter), advances it by one review, and converts back.
 *
 * Lives in app-core (the renderer bundle) rather than the desktop main process
 * so BOTH desktop and web get scheduling locally, with no AI call and no new
 * bridge/IPC surface. See the config note in `@shared/srs`.
 */

import { fsrs, Rating, type FSRS, type Grade } from 'ts-fsrs'
import type { FsrsRating, SrsState } from '@shared/flashcards'
import { fsrsCardToSrs, srsToFsrsCard } from '@shared/srs'

const RATING_BY_NAME: Record<FsrsRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy
}

// Standing scheduler config. `enable_short_term: false` disables intraday
// learning steps so scheduling round-trips losslessly through SrsState; fuzz
// stays on (FSRS default) to spread due dates and avoid review pile-ups.
let scheduler: FSRS | null = null
function getScheduler(): FSRS {
  if (!scheduler) scheduler = fsrs({ enable_short_term: false })
  return scheduler
}

export interface ScheduleResult {
  srs: SrsState
  nextDue: string
}

/**
 * Advance a card's SRS state by one review with the given rating. Deterministic
 * given `now` except for FSRS interval fuzz (which only perturbs `nextDue`).
 */
export function schedule(
  srs: SrsState,
  rating: FsrsRating,
  now: Date = new Date()
): ScheduleResult {
  const card = getScheduler().next(srsToFsrsCard(srs, now), now, RATING_BY_NAME[rating]).card
  const updated = fsrsCardToSrs(card, now)
  return { srs: updated, nextDue: updated.due ?? now.toISOString() }
}
