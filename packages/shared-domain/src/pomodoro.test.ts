import { describe, expect, it } from 'vitest'
import {
  DEFAULT_POMODORO_CONFIG,
  advancePomodoro,
  formatPomodoroClock,
  normalizePomodoroConfig,
  pausePomodoro,
  pomodoroRemainingMs,
  resumePomodoro,
  revivePomodoroState,
  skipPomodoroPhase,
  startPomodoro
} from './pomodoro'

const T0 = 1_750_000_000_000
const FOCUS_MS = DEFAULT_POMODORO_CONFIG.focusMinutes * 60_000
const BREAK_MS = DEFAULT_POMODORO_CONFIG.breakMinutes * 60_000
const LONG_BREAK_MS = DEFAULT_POMODORO_CONFIG.longBreakMinutes * 60_000
const EVERY = DEFAULT_POMODORO_CONFIG.longBreakEvery

describe('startPomodoro', () => {
  it('begins a running focus phase with no completed cycles', () => {
    const s = startPomodoro(T0)
    expect(s).toEqual({
      phase: 'focus',
      phaseEndsAt: T0 + FOCUS_MS,
      pausedAt: null,
      focusCount: 0,
      config: DEFAULT_POMODORO_CONFIG
    })
  })

  it('captures a custom config and uses its durations', () => {
    const s = startPomodoro(T0, { focusMinutes: 50, breakMinutes: 10, longBreakMinutes: 30, longBreakEvery: 2 })
    expect(pomodoroRemainingMs(s, T0)).toBe(50 * 60_000)
    const onBreak = advancePomodoro(s, s.phaseEndsAt).state
    expect(pomodoroRemainingMs(onBreak, onBreak.phaseEndsAt - 10 * 60_000)).toBe(10 * 60_000)
    // longBreakEvery: 2 → the second focus already earns the long break.
    const secondFocus = advancePomodoro(onBreak, onBreak.phaseEndsAt).state
    const secondRest = advancePomodoro(secondFocus, secondFocus.phaseEndsAt).state
    expect(secondRest.phase).toBe('longBreak')
  })

  it('sanitizes an out-of-range config on start', () => {
    const s = startPomodoro(T0, { focusMinutes: -3, breakMinutes: 9999, longBreakMinutes: NaN, longBreakEvery: 0 })
    expect(s.config).toEqual({ focusMinutes: 1, breakMinutes: 240, longBreakMinutes: 15, longBreakEvery: 1 })
  })
})

describe('normalizePomodoroConfig', () => {
  it('defaults missing or invalid fields', () => {
    expect(normalizePomodoroConfig(null)).toEqual(DEFAULT_POMODORO_CONFIG)
    expect(normalizePomodoroConfig({ focusMinutes: 'x', longBreakEvery: 3 })).toEqual({
      ...DEFAULT_POMODORO_CONFIG,
      longBreakEvery: 3
    })
  })

  it('clamps and rounds numeric fields', () => {
    expect(normalizePomodoroConfig({ focusMinutes: 52.6, breakMinutes: 0, longBreakMinutes: 500, longBreakEvery: 99 }))
      .toEqual({ focusMinutes: 53, breakMinutes: 1, longBreakMinutes: 240, longBreakEvery: 12 })
  })
})

describe('pomodoroRemainingMs', () => {
  it('derives remaining time from the deadline', () => {
    const s = startPomodoro(T0)
    expect(pomodoroRemainingMs(s, T0)).toBe(FOCUS_MS)
    expect(pomodoroRemainingMs(s, T0 + 60_000)).toBe(FOCUS_MS - 60_000)
  })

  it('clamps at zero once the deadline passes', () => {
    const s = startPomodoro(T0)
    expect(pomodoroRemainingMs(s, T0 + FOCUS_MS + 5_000)).toBe(0)
  })

  it('freezes at the pause moment while paused', () => {
    const s = pausePomodoro(startPomodoro(T0), T0 + 10_000)
    expect(pomodoroRemainingMs(s, T0 + 999_999)).toBe(FOCUS_MS - 10_000)
  })
})

describe('pause / resume', () => {
  it('resume shifts the deadline by the paused duration', () => {
    const paused = pausePomodoro(startPomodoro(T0), T0 + 10_000)
    const resumed = resumePomodoro(paused, T0 + 70_000) // paused for one minute
    expect(resumed.pausedAt).toBeNull()
    expect(pomodoroRemainingMs(resumed, T0 + 70_000)).toBe(FOCUS_MS - 10_000)
  })

  it('double pause and double resume are no-ops', () => {
    const s = startPomodoro(T0)
    const paused = pausePomodoro(s, T0 + 5_000)
    expect(pausePomodoro(paused, T0 + 9_000)).toBe(paused)
    expect(resumePomodoro(s, T0 + 9_000)).toBe(s)
  })
})

describe('advancePomodoro', () => {
  it('does nothing before the deadline', () => {
    const s = startPomodoro(T0)
    const res = advancePomodoro(s, T0 + FOCUS_MS - 1)
    expect(res.transitioned).toBe(false)
    expect(res.state).toBe(s)
  })

  it('moves focus → break at the deadline and counts the focus', () => {
    const s = startPomodoro(T0)
    const res = advancePomodoro(s, T0 + FOCUS_MS)
    expect(res.transitioned).toBe(true)
    expect(res.state.phase).toBe('break')
    expect(res.state.focusCount).toBe(1)
  })

  it('anchors the next phase to the missed deadline, not the late tick', () => {
    const s = startPomodoro(T0)
    const late = T0 + FOCUS_MS + 42_000
    const res = advancePomodoro(s, late)
    expect(res.state.phaseEndsAt).toBe(T0 + FOCUS_MS + BREAK_MS)
  })

  it('moves break → focus without counting another focus', () => {
    const onBreak = advancePomodoro(startPomodoro(T0), T0 + FOCUS_MS).state
    const res = advancePomodoro(onBreak, onBreak.phaseEndsAt)
    expect(res.transitioned).toBe(true)
    expect(res.state.phase).toBe('focus')
    expect(res.state.focusCount).toBe(1)
  })

  it(`gives a long break after the ${EVERY}th focus`, () => {
    let s = startPomodoro(T0)
    for (let i = 0; i < EVERY - 1; i++) {
      s = advancePomodoro(s, s.phaseEndsAt).state // → break
      expect(s.phase).toBe('break')
      s = advancePomodoro(s, s.phaseEndsAt).state // → focus
    }
    s = advancePomodoro(s, s.phaseEndsAt).state
    expect(s.phase).toBe('longBreak')
    expect(s.focusCount).toBe(EVERY)
    expect(pomodoroRemainingMs(s, s.phaseEndsAt - LONG_BREAK_MS)).toBe(LONG_BREAK_MS)
  })

  it('never transitions while paused, even past the deadline', () => {
    const paused = pausePomodoro(startPomodoro(T0), T0 + 1_000)
    const res = advancePomodoro(paused, T0 + FOCUS_MS * 2)
    expect(res.transitioned).toBe(false)
    expect(res.state).toBe(paused)
  })
})

describe('skipPomodoroPhase', () => {
  it('jumps mid-focus straight to a full break, counting the focus', () => {
    const s = skipPomodoroPhase(startPomodoro(T0), T0 + 60_000)
    expect(s.phase).toBe('break')
    expect(s.focusCount).toBe(1)
    expect(pomodoroRemainingMs(s, T0 + 60_000)).toBe(BREAK_MS)
  })

  it('unpauses: skipping a paused phase starts the next one running', () => {
    const paused = pausePomodoro(startPomodoro(T0), T0 + 5_000)
    const s = skipPomodoroPhase(paused, T0 + 90_000)
    expect(s.pausedAt).toBeNull()
    expect(s.phase).toBe('break')
  })
})

describe('revivePomodoroState', () => {
  it('round-trips a running timer whose deadline is still ahead', () => {
    const s = startPomodoro(T0)
    const revived = revivePomodoroState(JSON.parse(JSON.stringify(s)), T0 + 60_000)
    expect(revived).toEqual(s)
  })

  it('round-trips a paused timer regardless of elapsed wall time', () => {
    const paused = pausePomodoro(startPomodoro(T0), T0 + 10_000)
    const revived = revivePomodoroState(JSON.parse(JSON.stringify(paused)), T0 + FOCUS_MS * 10)
    expect(revived).toEqual(paused)
  })

  it('drops a running timer that expired while the app was closed', () => {
    const s = startPomodoro(T0)
    expect(revivePomodoroState(JSON.parse(JSON.stringify(s)), T0 + FOCUS_MS + 1)).toBeNull()
  })

  it('rejects malformed payloads', () => {
    expect(revivePomodoroState(null, T0)).toBeNull()
    expect(revivePomodoroState('nope', T0)).toBeNull()
    expect(revivePomodoroState({ phase: 'nap', phaseEndsAt: T0 + 1 }, T0)).toBeNull()
    expect(revivePomodoroState({ phase: 'focus', phaseEndsAt: 'soon' }, T0)).toBeNull()
  })

  it('normalizes a tampered config on revive', () => {
    const s = { ...startPomodoro(T0), config: { focusMinutes: -1 } }
    const revived = revivePomodoroState(s, T0)
    expect(revived?.config).toEqual({ ...DEFAULT_POMODORO_CONFIG, focusMinutes: 1 })
  })
})

describe('formatPomodoroClock', () => {
  it('renders m:ss and rounds partial seconds up', () => {
    expect(formatPomodoroClock(25 * 60_000)).toBe('25:00')
    expect(formatPomodoroClock(59_001)).toBe('1:00')
    expect(formatPomodoroClock(9_000)).toBe('0:09')
  })

  it('clamps zero and negative to 0:00', () => {
    expect(formatPomodoroClock(0)).toBe('0:00')
    expect(formatPomodoroClock(-5_000)).toBe('0:00')
  })
})
