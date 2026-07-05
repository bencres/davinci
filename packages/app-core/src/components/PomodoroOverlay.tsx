import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { formatPomodoroClock, pomodoroRemainingMs, type PomodoroPhase } from '@shared/pomodoro'
import { playPomodoroChime } from '../lib/study-feedback'
import { notifyPomodoroPhase } from '../lib/pomodoro-notify'
import { CloseIcon, MinimizeIcon } from './icons'

const PHASE_LABEL: Record<PomodoroPhase, string> = {
  focus: 'Focus',
  break: 'Break',
  longBreak: 'Long break'
}

/**
 * The pomodoro timer's bottom-right overlay (rendered inside App's corner
 * stack). Owns the single interval that drives the store's timer: display time
 * derives from timestamps, so the 500 ms cadence only affects render freshness,
 * never accuracy.
 */
export function PomodoroOverlay(): JSX.Element | null {
  const pomodoro = useStore((s) => s.pomodoro)
  const minimized = useStore((s) => s.pomodoroMinimized)
  const tickPomodoroTimer = useStore((s) => s.tickPomodoroTimer)
  const togglePomodoroPause = useStore((s) => s.togglePomodoroPause)
  const skipPomodoroPhase = useStore((s) => s.skipPomodoroPhase)
  const stopPomodoroTimer = useStore((s) => s.stopPomodoroTimer)
  const setPomodoroMinimized = useStore((s) => s.setPomodoroMinimized)

  const running = !!pomodoro
  const [, bump] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      if (tickPomodoroTimer()) {
        const s = useStore.getState()
        if (s.pomodoro) {
          if (s.studyGamification?.soundEnabled ?? true) {
            playPomodoroChime(s.pomodoro.phase === 'focus' ? 'focus' : 'rest')
          }
          if (s.studyGamification?.pomodoroNotificationsEnabled ?? true) {
            notifyPomodoroPhase(s.pomodoro)
          }
        }
      }
      bump((n) => n + 1) // refresh the displayed clock
    }, 500)
    return () => clearInterval(id)
  }, [running, tickPomodoroTimer])

  if (!pomodoro) return null

  const paused = pomodoro.pausedAt !== null
  const resting = pomodoro.phase !== 'focus'
  const clock = formatPomodoroClock(pomodoroRemainingMs(pomodoro, Date.now()))
  const dotClass = `h-2 w-2 shrink-0 rounded-full ${
    paused ? 'bg-ink-400' : resting ? 'bg-emerald-500' : 'bg-accent'
  }`

  if (minimized) {
    return (
      <button
        type="button"
        title={`${PHASE_LABEL[pomodoro.phase]}${paused ? ' (paused)' : ''} — click to expand`}
        onClick={() => setPomodoroMinimized(false)}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-accent/30 bg-paper-50/95 px-3 py-1.5 text-sm font-medium text-ink-800 shadow-float backdrop-blur hover:bg-paper-100"
      >
        <span className={dotClass} />
        <span className="tabular-nums">{clock}</span>
      </button>
    )
  }

  // Filled dots = focus phases completed toward the long break.
  const longBreakEvery = pomodoro.config.longBreakEvery
  const filledCycles =
    pomodoro.phase === 'longBreak' ? longBreakEvery : pomodoro.focusCount % longBreakEvery

  return (
    <div
      role="timer"
      className="pointer-events-auto flex w-56 flex-col gap-2 rounded-xl border border-accent/30 bg-paper-50/95 px-3 py-2.5 text-sm text-ink-800 shadow-float backdrop-blur"
    >
      <div className="flex items-center gap-2">
        <span className={dotClass} />
        <span className="min-w-0 truncate font-medium">
          {PHASE_LABEL[pomodoro.phase]}
          {paused && <span className="text-ink-500"> · paused</span>}
        </span>
        <span className="ml-auto flex items-center gap-1" aria-label="Cycles until long break">
          {Array.from({ length: longBreakEvery }, (_, i) => (
            <span
              key={i}
              className={`h-1.5 w-1.5 rounded-full ${i < filledCycles ? 'bg-accent' : 'bg-paper-300'}`}
            />
          ))}
        </span>
        <button
          type="button"
          title="Minimize"
          onClick={() => setPomodoroMinimized(true)}
          className="shrink-0 rounded-md p-0.5 text-ink-500 hover:bg-paper-200 hover:text-ink-800"
        >
          <MinimizeIcon width={14} height={14} />
        </button>
        <button
          type="button"
          title="Stop timer"
          onClick={stopPomodoroTimer}
          className="shrink-0 rounded-md p-0.5 text-ink-500 hover:bg-paper-200 hover:text-ink-800"
        >
          <CloseIcon width={14} height={14} />
        </button>
      </div>
      <div className="text-center text-3xl font-semibold tabular-nums text-ink-900">{clock}</div>
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={togglePomodoroPause}
          className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/15"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={skipPomodoroPhase}
          className="rounded-lg border border-paper-300 bg-paper-50 px-2.5 py-1 text-xs font-medium text-ink-600 transition-colors hover:bg-paper-200"
        >
          {resting ? 'Skip to focus' : 'Skip to break'}
        </button>
      </div>
    </div>
  )
}
