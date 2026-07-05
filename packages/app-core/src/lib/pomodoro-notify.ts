/**
 * OS notifications for pomodoro phase transitions, via the HTML5 Notification
 * API — native on the Electron renderer (auto-granted) and permission-gated in
 * browsers. Best-effort like the study sounds: never throws, never blocks.
 */
import { pomodoroPhaseDurationMs, type PomodoroState } from '@shared/pomodoro'

/**
 * Ask for permission if the user hasn't answered yet. Called from the
 * start-timer action so (in browsers) the prompt appears inside the user's
 * click/keypress gesture, where Chrome allows it.
 */
export function requestPomodoroNotificationPermission(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
  } catch {
    // Notifications are a nicety; swallow everything.
  }
}

/** One-line body for the phase the timer just moved into. */
function phaseMessage(state: PomodoroState): string {
  const minutes = Math.round(pomodoroPhaseDurationMs(state.phase, state.config) / 60_000)
  if (state.phase === 'focus') return `Break's over — time to focus (${minutes} min).`
  if (state.phase === 'longBreak') return `Focus complete — enjoy a ${minutes}-minute long break.`
  return `Focus complete — take a ${minutes}-minute break.`
}

/**
 * Announce the phase `state` just transitioned into. Skipped while the window
 * is focused — the overlay (and its chime) already carry the moment; the OS
 * notification is for when attention is elsewhere.
 */
export function notifyPomodoroPhase(state: PomodoroState): void {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    if (typeof document !== 'undefined' && document.hasFocus()) return
    new Notification('ZenNotes', {
      body: phaseMessage(state),
      // The in-app chime is the sound; keep the OS side quiet to avoid doubling.
      silent: true,
      tag: 'zen-pomodoro'
    })
  } catch {
    // Notifications are a nicety; swallow everything.
  }
}
