/**
 * The "feel" layer for the study reveal/grade moment — kept out of `StudyView`
 * so the component stays a clean Fast Refresh boundary (see commit f092a15).
 *
 * Two ideas live here: a pure rating → feedback-tier mapping that drives the
 * asymmetric win/loss treatment, and a tiny, best-effort success chime. Both are
 * renderer-only; nothing here touches FSRS, the queue, or persisted data.
 */

import { ratingToNumber, type FsrsRating } from '@shared/flashcards'

/**
 * How a grade should *feel*. `good`/`easy` earn an amplified celebratory beat;
 * `again`/`hard` get a quiet, non-punishing acknowledgement — never a failure read.
 */
export type FeedbackTier = 'win' | 'soft'

/** Map an FSRS rating to its feedback tier. Pure — unit-tested. */
export function ratingToFeedbackTier(rating: FsrsRating): FeedbackTier {
  return rating === 'good' || rating === 'easy' ? 'win' : 'soft'
}

// --- Calibration note (prediction vs. actual, shown at the grade moment) ----

const RATING_LABEL: Record<FsrsRating, string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy'
}

/** The moment-of-grading readout of a prediction: matched, or leaned which way. */
export interface CalibrationNote {
  text: string
  /** `hit` = predicted right; `over` = over-confident; `under` = under-confident. */
  tone: 'hit' | 'over' | 'under'
}

/**
 * Compare the learner's pre-reveal prediction to the actual grade, for the brief
 * post-grade flash — calibration trains best when the mismatch is seen at the
 * moment it happens, not later on a dashboard. Pure — unit-tested. Returns null
 * when no prediction was made (predicting is optional).
 */
export function calibrationNote(
  predicted: FsrsRating | null | undefined,
  actual: FsrsRating
): CalibrationNote | null {
  if (!predicted) return null
  if (predicted === actual) return { text: 'Predicted right ✓', tone: 'hit' }
  return {
    text: `Predicted ${RATING_LABEL[predicted]} → ${RATING_LABEL[actual]}`,
    tone: ratingToNumber(predicted) > ratingToNumber(actual) ? 'over' : 'under'
  }
}

// --- Animation timing -------------------------------------------------------
// Kept well under 250ms so the loop never feels gated on an animation.

/** Front → revealed flip/settle. */
export const REVEAL_FLIP_MS = 180

/** How long the post-grade celebration `feedback` state stays set before clearing.
 *  Must outlast the win's card-border circuit trace (~1300ms), plus a buffer. */
export const GRADE_FLASH_MS = 1400

// --- Motion preference ------------------------------------------------------

/**
 * Whether the OS asks us to minimize motion. SSR-safe and defensive: any failure
 * (missing `matchMedia`, etc.) is treated as "no preference" so motion still works.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

// --- Success chime ----------------------------------------------------------

/** Lazily-created shared context so we don't spin one up until the first chime. */
let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    audioContext ??= new Ctor()
    return audioContext
  } catch {
    return null
  }
}

/**
 * Play a short, quiet, rising two-note chime for a `win`. Best-effort and
 * non-blocking: it returns immediately, never throws, and never gates grading.
 * Volume is intentionally low (peak gain ~0.05). Callers gate this behind the
 * user's sound setting and the `win` tier.
 */
export function playStudyChime(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    // Browsers may start the context suspended until a user gesture; grading is a
    // gesture, so resume is safe and a no-op when already running.
    void ctx.resume?.()
    const now = ctx.currentTime
    // A gentle rising perfect-fourth: C6 → F6.
    const notes = [1046.5, 1396.9]
    const noteDur = 0.12
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * noteDur * 0.85
      const end = start + noteDur
      // Quick attack, smooth release; peak well below unity so it never startles.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.04, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(end + 0.02)
    })
  } catch {
    // Audio is a nicety; swallow everything (autoplay policy, decode errors, …).
  }
}

/**
 * Pomodoro phase-transition chime. `next: 'rest'` (a break just started) plays a
 * brighter three-note rise as the reward; `next: 'focus'` (back to work) plays a
 * gentler two-note figure. Unlike the study chime this can fire without a user
 * gesture (the timer runs on an interval), so a suspended context may keep it
 * silent — best-effort, like every sound here. Callers gate it behind the
 * user's sound setting.
 */
export function playPomodoroChime(next: 'focus' | 'rest'): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    void ctx.resume?.()
    const now = ctx.currentTime
    // Rest earned: C6 → E6 → G6 arpeggio. Back to focus: G5 → C6.
    const notes = next === 'rest' ? [1046.5, 1318.5, 1568.0] : [784.0, 1046.5]
    const noteDur = 0.14
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * noteDur * 0.85
      const end = start + noteDur
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.04, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(end + 0.02)
    })
  } catch {
    // Audio is a nicety; swallow everything.
  }
}

/**
 * A very soft, short "tick" for the reveal moment — gentler and quieter than the
 * win chime so it can fire on every reveal without fatiguing. Best-effort and
 * non-blocking; callers gate it behind the user's sound setting.
 */
export function playStudyTick(): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    void ctx.resume?.()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    // A small, warm woodblock-ish tap.
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(660, now)
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.05)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.025, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.08)
  } catch {
    // Audio is a nicety; swallow everything.
  }
}
