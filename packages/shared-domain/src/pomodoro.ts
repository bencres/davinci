/**
 * Pomodoro timer state machine (pure). The renderer keeps one `PomodoroState`
 * in its store and ticks it with `advancePomodoro`; everything here derives
 * from timestamps (`phaseEndsAt` vs `now`), never a decremented counter, so a
 * throttled interval or a laptop lid-close can't drift the clock.
 *
 * Durations are configurable (persisted in `StudyGamification.pomodoro`, see
 * `study-stats.ts`). A running timer captures its config at start, so editing
 * settings mid-session never warps an in-flight phase — the new durations
 * apply from the next `startPomodoro`.
 */

export interface PomodoroConfig {
  focusMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  /** Every Nth completed focus phase earns the long break. */
  longBreakEvery: number
}

export const DEFAULT_POMODORO_CONFIG: PomodoroConfig = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4
}

/** Clamp a raw minutes/count value into a sane range (defaults on miss). */
function normalizedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Coerce arbitrary parsed JSON into a valid `PomodoroConfig` (defaults on miss). */
export function normalizePomodoroConfig(raw: unknown): PomodoroConfig {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<PomodoroConfig>
  const d = DEFAULT_POMODORO_CONFIG
  return {
    focusMinutes: normalizedInt(obj.focusMinutes, d.focusMinutes, 1, 240),
    breakMinutes: normalizedInt(obj.breakMinutes, d.breakMinutes, 1, 240),
    longBreakMinutes: normalizedInt(obj.longBreakMinutes, d.longBreakMinutes, 1, 240),
    longBreakEvery: normalizedInt(obj.longBreakEvery, d.longBreakEvery, 1, 12)
  }
}

export type PomodoroPhase = 'focus' | 'break' | 'longBreak'

const PHASES: readonly PomodoroPhase[] = ['focus', 'break', 'longBreak']

export interface PomodoroState {
  phase: PomodoroPhase
  /** Epoch ms when the current phase ends (frozen while paused). */
  phaseEndsAt: number
  /** Epoch ms when the timer was paused, or null while running. */
  pausedAt: number | null
  /** Completed focus phases — drives the long-break cadence. */
  focusCount: number
  /** Durations captured at `startPomodoro`; the whole session uses these. */
  config: PomodoroConfig
}

export function pomodoroPhaseDurationMs(phase: PomodoroPhase, config: PomodoroConfig): number {
  const minutes =
    phase === 'focus'
      ? config.focusMinutes
      : phase === 'break'
        ? config.breakMinutes
        : config.longBreakMinutes
  return minutes * 60_000
}

/** Begin a fresh timer in its first focus phase. */
export function startPomodoro(
  now: number,
  config: PomodoroConfig = DEFAULT_POMODORO_CONFIG
): PomodoroState {
  const normalized = normalizePomodoroConfig(config)
  return {
    phase: 'focus',
    phaseEndsAt: now + pomodoroPhaseDurationMs('focus', normalized),
    pausedAt: null,
    focusCount: 0,
    config: normalized
  }
}

/** Milliseconds left in the current phase (clamped at 0; frozen while paused). */
export function pomodoroRemainingMs(state: PomodoroState, now: number): number {
  const reference = state.pausedAt ?? now
  return Math.max(0, state.phaseEndsAt - reference)
}

export function pausePomodoro(state: PomodoroState, now: number): PomodoroState {
  if (state.pausedAt !== null) return state
  return { ...state, pausedAt: now }
}

export function resumePomodoro(state: PomodoroState, now: number): PomodoroState {
  if (state.pausedAt === null) return state
  // Shift the deadline by however long we sat paused, then unfreeze.
  return { ...state, phaseEndsAt: state.phaseEndsAt + (now - state.pausedAt), pausedAt: null }
}

/** The phase that follows `state`'s current one, with its bookkeeping. */
function nextPhase(state: PomodoroState, now: number): PomodoroState {
  if (state.phase === 'focus') {
    const focusCount = state.focusCount + 1
    const phase: PomodoroPhase =
      focusCount % state.config.longBreakEvery === 0 ? 'longBreak' : 'break'
    return {
      phase,
      phaseEndsAt: now + pomodoroPhaseDurationMs(phase, state.config),
      pausedAt: null,
      focusCount,
      config: state.config
    }
  }
  return {
    phase: 'focus',
    phaseEndsAt: now + pomodoroPhaseDurationMs('focus', state.config),
    pausedAt: null,
    focusCount: state.focusCount,
    config: state.config
  }
}

/** Jump to the next phase immediately (skip button). Unpauses if paused. */
export function skipPomodoroPhase(state: PomodoroState, now: number): PomodoroState {
  return nextPhase(state, now)
}

/**
 * Roll the state forward to `now`. When the current phase's deadline has
 * passed, the timer moves to the next phase and `transitioned` is true so the
 * caller can play a chime / notify. Paused timers never transition.
 */
export function advancePomodoro(
  state: PomodoroState,
  now: number
): { state: PomodoroState; transitioned: boolean } {
  if (state.pausedAt !== null || now < state.phaseEndsAt) return { state, transitioned: false }
  // Start the next phase from the moment the previous one actually ended, so
  // a delayed tick (background tab, sleep) doesn't stretch the schedule.
  return { state: nextPhase(state, state.phaseEndsAt), transitioned: true }
}

/**
 * Rebuild a persisted timer on app start. Paused timers come back paused, a
 * running phase whose deadline is still ahead keeps ticking, and a timer that
 * expired while the app was closed is dropped (returns null) — resuming a
 * long-dead session would be noise, not focus.
 */
export function revivePomodoroState(raw: unknown, now: number): PomodoroState | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Partial<PomodoroState>
  if (!PHASES.includes(obj.phase as PomodoroPhase)) return null
  if (typeof obj.phaseEndsAt !== 'number' || !Number.isFinite(obj.phaseEndsAt)) return null
  const pausedAt = typeof obj.pausedAt === 'number' && Number.isFinite(obj.pausedAt) ? obj.pausedAt : null
  const focusCount =
    typeof obj.focusCount === 'number' && Number.isFinite(obj.focusCount) && obj.focusCount >= 0
      ? Math.round(obj.focusCount)
      : 0
  if (pausedAt === null && obj.phaseEndsAt <= now) return null
  return {
    phase: obj.phase as PomodoroPhase,
    phaseEndsAt: obj.phaseEndsAt,
    pausedAt,
    focusCount,
    config: normalizePomodoroConfig(obj.config)
  }
}

/** "24:59"-style clock for the overlay (minutes can exceed 59 for long phases). */
export function formatPomodoroClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
