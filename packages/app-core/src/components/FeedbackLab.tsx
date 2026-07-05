// TEMP(feedback-lab): a scratch playground for auditioning grade-feedback
// patterns (visual + sound). Self-contained — all CSS is inline below and all
// audio is synthesized via the Web Audio API, so deleting this file plus the
// few `TEMP(feedback-lab)` references (shared-domain flashcards.ts,
// lib/workspace-tabs.ts, lib/commands.ts, EditorPane.tsx) fully removes it.
//
// Open via the command palette: "Study: Open Feedback Lab (temp)".

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

// --- tiny Web Audio toolkit -------------------------------------------------

let audio: AudioContext | null = null
function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!C) return null
  try {
    audio ??= new C()
    void audio.resume?.()
    return audio
  } catch {
    return null
  }
}
function t0(): number {
  return ctx()?.currentTime ?? 0
}
/** A single enveloped oscillator tone (optionally gliding in pitch). */
function tone(
  freq: number,
  start: number,
  dur: number,
  opts?: { type?: OscillatorType; gain?: number; glideTo?: number }
): void {
  const c = ctx()
  if (!c) return
  const o = c.createOscillator()
  const g = c.createGain()
  o.type = opts?.type ?? 'sine'
  o.frequency.setValueAtTime(freq, start)
  if (opts?.glideTo) o.frequency.exponentialRampToValueAtTime(opts.glideTo, start + dur)
  const peak = opts?.gain ?? 0.06
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(peak, start + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  o.connect(g).connect(c.destination)
  o.start(start)
  o.stop(start + dur + 0.02)
}
/** A filtered noise burst — for whooshes, pops, clicks. */
function noise(
  start: number,
  dur: number,
  opts?: { type?: BiquadFilterType; freq?: number; gain?: number; sweepTo?: number }
): void {
  const c = ctx()
  if (!c) return
  const n = Math.max(1, Math.floor(c.sampleRate * dur))
  const buf = c.createBuffer(1, n, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1
  const src = c.createBufferSource()
  src.buffer = buf
  const f = c.createBiquadFilter()
  f.type = opts?.type ?? 'bandpass'
  f.frequency.setValueAtTime(opts?.freq ?? 1200, start)
  if (opts?.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, start + dur)
  const g = c.createGain()
  const peak = opts?.gain ?? 0.05
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(peak, start + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  src.connect(f).connect(g).connect(c.destination)
  src.start(start)
  src.stop(start + dur)
}
/** Play a list of freqs as an arpeggio. */
function arp(freqs: number[], step: number, dur: number, type: OscillatorType = 'triangle', gain = 0.05): void {
  const s = t0()
  freqs.forEach((f, i) => tone(f, s + i * step, dur, { type, gain }))
}

/** The six favorite sounds, named so combinations can reuse them by reference. */
const SOUND = {
  // #1 — rising two-note chime
  chime: (): void => {
    const s = t0()
    tone(1046.5, s, 0.12)
    tone(1396.9, s + 0.1, 0.14)
  },
  // #2 — soft low pad swell
  pad: (): void => {
    const s = t0()
    tone(293.66, s, 0.5, { gain: 0.05 })
    tone(440, s, 0.5, { gain: 0.03 })
  },
  // #7 — bright marimba two-note
  marimba: (): void => {
    const s = t0()
    tone(523, s, 0.18, { type: 'triangle', gain: 0.07 })
    tone(784, s + 0.03, 0.16, { type: 'triangle', gain: 0.05 })
  },
  // #8 — ascending three-note arpeggio
  sweepArp: (): void => arp([659, 880, 1175], 0.09, 0.12),
  // #9 — warm three-note chord
  chord: (): void => {
    const s = t0()
    tone(392, s, 0.4, { gain: 0.05 })
    tone(494, s, 0.4, { gain: 0.045 })
    tone(587, s, 0.4, { gain: 0.04 })
  },
  // #12 — two-tone success ding
  ding: (): void => {
    const s = t0()
    tone(1318, s, 0.12, { type: 'sine', gain: 0.06 })
    tone(1976, s + 0.1, 0.22, { type: 'sine', gain: 0.06 })
  }
}

// --- a CSS var helper so TS is happy with custom properties -----------------
const vars = (o: Record<string, string | number>): CSSProperties => o as CSSProperties

// --- random-particle overlay ------------------------------------------------

function Confetti(): JSX.Element {
  const pieces = useMemo(
    () =>
      Array.from({ length: 20 }, () => {
        const ang = Math.random() * Math.PI * 2
        const dist = 70 + Math.random() * 150
        return {
          dx: Math.cos(ang) * dist,
          dy: Math.sin(ang) * dist,
          rot: Math.random() * 540 - 270,
          delay: Math.random() * 60,
          accent: Math.random() > 0.45
        }
      }),
    []
  )
  return (
    <>
      {pieces.map((p, i) => (
        <span
          key={i}
          className="flab-confetti-pc"
          style={vars({
            '--dx': `${p.dx}px`,
            '--dy': `${p.dy}px`,
            '--rot': `${p.rot}deg`,
            animationDelay: `${p.delay}ms`,
            background: p.accent ? 'rgb(var(--z-accent))' : 'rgb(var(--z-fg) / 0.55)'
          })}
        />
      ))}
    </>
  )
}

// --- reusable visual fragments ----------------------------------------------

const ViewCircuit = (): ReactNode => (
  <svg className="flab-circuit" aria-hidden>
    <rect x="0" y="0" width="100%" height="100%" pathLength={100} />
  </svg>
)
const CardTrace = (extra = ''): ReactNode => (
  <svg className={`flab-card-trace ${extra}`} aria-hidden>
    <rect x="0" y="0" width="100%" height="100%" rx="14" pathLength={100} />
  </svg>
)
const Checkmark = (extra = ''): ReactNode => (
  <svg className={`flab-check ${extra}`} viewBox="0 0 100 100" aria-hidden>
    <path d="M20,52 L43,75 L82,28" pathLength={100} />
  </svg>
)

// --- the pattern catalogue --------------------------------------------------

interface Pattern {
  id: string
  title: string
  desc: string
  keywords: string[]
  /** Which sound from SOUND it reuses, for the badge. */
  soundNote?: string
  /** Transform class applied to the mock card. */
  cardClass?: string
  /** Class applied to the card's body text. */
  textClass?: string
  /** Overlay rendered behind the card's content (clipped to the card). */
  cardBg?: () => ReactNode
  /** Overlay rendered over the card's border (not clipped). */
  cardEdge?: () => ReactNode
  /** Overlay rendered over the whole stage / "view". */
  stageOverlay?: () => ReactNode
  sound: () => void
}

// Round 4 — mixes of Round 3's #1 (spring pop), #3 (background flood), and
// #10 (neon circuit). All use the #1 chime.
const ROUND4: Pattern[] = [
  {
    id: 'r4-pop-flood',
    title: 'Circuit + pop + flood',
    desc: 'Regular border circuit, spring pop, and an accent background flood — all at once.',
    keywords: ['circuit', 'pop', 'flood', 'spring', 'combo'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop',
    cardBg: () => <div className="flab-card-flood" aria-hidden />,
    cardEdge: () => CardTrace(),
    sound: SOUND.chime
  },
  {
    id: 'r4-neon-pop',
    title: 'Neon + spring pop',
    desc: 'The fat neon trace lights up while the card springs. Bold and bouncy.',
    keywords: ['neon', 'pop', 'spring', 'bright', 'bold'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop',
    cardEdge: () => CardTrace('neon'),
    sound: SOUND.chime
  },
  {
    id: 'r4-neon-flood',
    title: 'Neon + background flood',
    desc: 'Neon trace around a card whose background floods with accent. Saturated, glowing.',
    keywords: ['neon', 'flood', 'background', 'saturated', 'glow'],
    soundNote: '#1 chime',
    cardBg: () => <div className="flab-card-flood" aria-hidden />,
    cardEdge: () => CardTrace('neon'),
    sound: SOUND.chime
  },
  {
    id: 'r4-neon-pop-flood',
    title: 'Neon + pop + flood',
    desc: 'The works: neon trace, spring pop, and a background flood together.',
    keywords: ['neon', 'pop', 'flood', 'works', 'combo'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop',
    cardBg: () => <div className="flab-card-flood" aria-hidden />,
    cardEdge: () => CardTrace('neon'),
    sound: SOUND.chime
  },
  {
    id: 'r4-big',
    title: 'Big pop + deep flood',
    desc: 'A punchier take — larger overshoot pop and a deeper, longer accent flood, regular trace.',
    keywords: ['circuit', 'big', 'deep', 'punch', 'overshoot'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop-big',
    cardBg: () => <div className="flab-card-flood-deep" aria-hidden />,
    cardEdge: () => CardTrace(),
    sound: SOUND.chime
  },
  {
    id: 'r4-jackpot',
    title: 'Jackpot (neon + big pop + deep flood)',
    desc: 'Everything dialed up: neon trace, big overshoot pop, and a deep lingering flood.',
    keywords: ['neon', 'jackpot', 'big', 'deep', 'max'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop-big',
    cardBg: () => <div className="flab-card-flood-deep" aria-hidden />,
    cardEdge: () => CardTrace('neon'),
    sound: SOUND.chime
  }
]

// Round 3 — everything anchored on the card border circuit (the favorite).
const CARD_CIRCUIT: Pattern[] = [
  {
    id: 'cc-pop',
    title: 'Circuit + spring pop',
    desc: 'The card springs up as its border traces — the loop closes right as it settles.',
    keywords: ['circuit', 'spring', 'pop', 'card', 'combo'],
    soundNote: '#1 chime',
    cardClass: 'flab-anim-pop',
    cardEdge: () => CardTrace(),
    sound: SOUND.chime
  },
  {
    id: 'cc-afterglow',
    title: 'Circuit + afterglow halo',
    desc: 'The border traces, then a soft halo lingers on the card edge in its wake.',
    keywords: ['circuit', 'halo', 'afterglow', 'glow', 'soft'],
    soundNote: '#2 pad',
    cardEdge: () => (
      <>
        {CardTrace()}
        <div className="flab-card-halo" style={{ animationDelay: '320ms' }} aria-hidden />
      </>
    ),
    sound: SOUND.pad
  },
  {
    id: 'cc-flood',
    title: 'Circuit + background flood',
    desc: 'The border traces while accent floods the card background behind the text.',
    keywords: ['circuit', 'flood', 'background', 'fill', 'warm'],
    soundNote: '#9 chord',
    cardBg: () => <div className="flab-card-flood" aria-hidden />,
    cardEdge: () => CardTrace(),
    sound: SOUND.chord
  },
  {
    id: 'cc-text',
    title: 'Circuit + text ignite',
    desc: 'The border traces and the answer text flares accent at the same moment.',
    keywords: ['circuit', 'text', 'ignite', 'glow', 'content'],
    soundNote: '#1 chime',
    textClass: 'flab-text-ignite',
    cardEdge: () => CardTrace(),
    sound: SOUND.chime
  },
  {
    id: 'cc-lift',
    title: 'Circuit + lift / depth',
    desc: 'The card rises toward you with a soft shadow as the border traces around it.',
    keywords: ['circuit', 'lift', 'depth', 'elevate', 'shadow'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-lift',
    cardEdge: () => CardTrace(),
    sound: SOUND.marimba
  },
  {
    id: 'cc-check',
    title: 'Circuit + inner checkmark',
    desc: 'The border traces, then a checkmark draws in the center of the card.',
    keywords: ['circuit', 'check', 'confirm', 'tick', 'combo'],
    soundNote: '#12 ding',
    cardEdge: () => (
      <>
        {CardTrace()}
        {Checkmark('sm')}
      </>
    ),
    sound: SOUND.ding
  },
  {
    id: 'cc-sheen',
    title: 'Circuit + sheen sweep',
    desc: 'A gloss sweeps across the card face while the border traces around it. Slick.',
    keywords: ['circuit', 'sheen', 'sweep', 'gloss', 'premium'],
    soundNote: '#8 arp',
    cardBg: () => <div className="flab-card-sheen" aria-hidden />,
    cardEdge: () => CardTrace(),
    sound: SOUND.sweepArp
  },
  {
    id: 'cc-nested',
    title: 'Nested double circuit',
    desc: 'Both the card border and the whole view border trace together — concentric loops.',
    keywords: ['circuit', 'nested', 'double', 'view', 'concentric'],
    soundNote: '#1 chime',
    cardEdge: () => CardTrace(),
    stageOverlay: ViewCircuit,
    sound: SOUND.chime
  },
  {
    id: 'cc-ring',
    title: 'Circuit → outline pulse',
    desc: 'The border traces, then snaps an outline ring that radiates off the card.',
    keywords: ['circuit', 'ring', 'pulse', 'snap', 'outline'],
    soundNote: '#12 ding',
    cardEdge: () => (
      <>
        {CardTrace()}
        <div className="flab-card-ring" style={{ animationDelay: '300ms' }} aria-hidden />
      </>
    ),
    sound: SOUND.ding
  },
  {
    id: 'cc-neon',
    title: 'Neon circuit',
    desc: 'The same trace, thicker and slower with a heavy bloom — a fat neon tube lighting up.',
    keywords: ['circuit', 'neon', 'thick', 'bloom', 'bright'],
    soundNote: '#1 chime',
    cardEdge: () => CardTrace('neon'),
    sound: SOUND.chime
  },
  {
    id: 'cc-progress',
    title: 'Circuit + progress fill',
    desc: 'The card border traces while a progress bar fills along the bottom of the view.',
    keywords: ['circuit', 'progress', 'bar', 'advance', 'combo'],
    soundNote: '#7 marimba',
    cardEdge: () => CardTrace(),
    stageOverlay: () => <div className="flab-progress" aria-hidden />,
    sound: SOUND.marimba
  }
]

// Round 2 — combinations of the favorites, applied to different surfaces.
const COMBOS: Pattern[] = [
  {
    id: 'card-circuit',
    title: 'Card border circuit',
    desc: 'The circuit trace runs around the card itself instead of the whole view — tighter, more focused.',
    keywords: ['card', 'border', 'circuit', 'trace', 'focused'],
    soundNote: '#1 chime',
    cardEdge: CardTrace,
    sound: SOUND.chime
  },
  {
    id: 'card-ring',
    title: 'Card outline pulse',
    desc: 'A crisp accent outline snaps onto the card border and an expanding ring radiates out.',
    keywords: ['card', 'outline', 'ring', 'pulse', 'snap'],
    soundNote: '#12 ding',
    cardEdge: () => <div className="flab-card-ring" aria-hidden />,
    sound: SOUND.ding
  },
  {
    id: 'card-halo',
    title: 'Card edge halo',
    desc: 'Edge glow pulse, but hugging the card border — a soft inner + outer accent halo.',
    keywords: ['card', 'halo', 'glow', 'soft', 'edge'],
    soundNote: '#2 pad',
    cardEdge: () => <div className="flab-card-halo" aria-hidden />,
    sound: SOUND.pad
  },
  {
    id: 'card-flood',
    title: 'Card background flood',
    desc: "The card's background floods with accent behind the text, then settles. Warm, contained.",
    keywords: ['card', 'background', 'flood', 'fill', 'tint'],
    soundNote: '#9 chord',
    cardBg: () => <div className="flab-card-flood" aria-hidden />,
    sound: SOUND.chord
  },
  {
    id: 'card-sheen',
    title: 'Card sheen sweep',
    desc: 'A gloss sweeps across the card face only (clipped to its rounded rect). Slick, premium.',
    keywords: ['card', 'sheen', 'sweep', 'gloss', 'shine'],
    soundNote: '#8 arp',
    cardBg: () => <div className="flab-card-sheen" aria-hidden />,
    sound: SOUND.sweepArp
  },
  {
    id: 'text-ignite',
    title: 'Text ignite glow',
    desc: 'The answer text itself flares accent and scales up briefly. Draws the eye to the content.',
    keywords: ['text', 'glow', 'ignite', 'type', 'content'],
    soundNote: '#2 pad',
    textClass: 'flab-text-ignite',
    sound: SOUND.pad
  },
  {
    id: 'text-flash',
    title: 'Text color flash',
    desc: 'The text snaps to the accent color and back. Minimal, precise — no motion.',
    keywords: ['text', 'color', 'flash', 'tint', 'minimal'],
    soundNote: '#12 ding',
    textClass: 'flab-text-flash',
    sound: SOUND.ding
  },
  {
    id: 'text-underline',
    title: 'Text underline draw',
    desc: 'An accent underline sweeps in beneath the text, like the line sweep but tied to the words.',
    keywords: ['text', 'underline', 'sweep', 'draw', 'sheen'],
    soundNote: '#8 arp',
    textClass: 'flab-text-underline',
    sound: SOUND.sweepArp
  },
  {
    id: 'pop-glow',
    title: 'Spring pop + edge glow',
    desc: 'The card springs up while its border lights with a halo — bouncy and luminous together.',
    keywords: ['card', 'spring', 'pop', 'glow', 'combo'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-pop',
    cardEdge: () => <div className="flab-card-halo" aria-hidden />,
    sound: SOUND.marimba
  },
  {
    id: 'lift',
    title: 'Card lift / depth',
    desc: 'The card rises toward you with a growing accent drop-shadow — elevation, weightless.',
    keywords: ['card', 'lift', 'depth', 'shadow', 'elevate'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-lift',
    sound: SOUND.marimba
  },
  {
    id: 'circuit-check',
    title: 'View circuit + checkmark',
    desc: 'The border circuit traces the view while a checkmark draws in the center — confirm + circuit.',
    keywords: ['circuit', 'check', 'confirm', 'combo', 'view'],
    soundNote: '#12 ding',
    stageOverlay: () => (
      <>
        {ViewCircuit()}
        {Checkmark()}
      </>
    ),
    sound: SOUND.ding
  },
  {
    id: 'rails-pop',
    title: 'Side rails + spring',
    desc: 'Comets streak up the view edges while the card springs to meet them. Energetic, lively.',
    keywords: ['rails', 'spring', 'rise', 'combo', 'energetic'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-pop',
    stageOverlay: () => (
      <>
        <span className="flab-rail l" aria-hidden />
        <span className="flab-rail r" aria-hidden />
      </>
    ),
    sound: SOUND.marimba
  },
  {
    id: 'sweep-flood',
    title: 'View sweep → flood',
    desc: 'A sheen sweeps across the whole view and leaves a fading accent wash in its wake.',
    keywords: ['sweep', 'flood', 'wash', 'combo', 'premium'],
    soundNote: '#9 chord',
    stageOverlay: () => (
      <>
        <div className="flab-flood" aria-hidden />
        <div className="flab-sweep" aria-hidden />
      </>
    ),
    sound: SOUND.chord
  },
  {
    id: 'progress-pop',
    title: 'Progress fill + pop',
    desc: 'A progress bar fills along the bottom edge of the view as the card pops — felt advancement.',
    keywords: ['progress', 'bar', 'fill', 'advance', 'combo'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-pop',
    stageOverlay: () => <div className="flab-progress" aria-hidden />,
    sound: SOUND.marimba
  }
]

// Round 1 — the originals, kept for comparison.
const ORIGINALS: Pattern[] = [
  {
    id: 'circuit',
    title: 'Border circuit trace',
    desc: 'One continuous line races around the whole view border, then the closed loop blooms.',
    keywords: ['outline', 'lightning', 'circuit', 'perimeter'],
    soundNote: '#1 chime',
    stageOverlay: ViewCircuit,
    sound: SOUND.chime
  },
  {
    id: 'edge',
    title: 'Edge glow pulse',
    desc: 'A soft inset halo swells from the view edges and fades. Calm, ambient.',
    keywords: ['glow', 'halo', 'vignette', 'soft'],
    soundNote: '#2 pad',
    stageOverlay: () => <div className="flab-edge" aria-hidden />,
    sound: SOUND.pad
  },
  {
    id: 'confetti',
    title: 'Confetti burst',
    desc: 'Particles fly out from the center and tumble away. Playful.',
    keywords: ['confetti', 'particles', 'burst', 'party'],
    stageOverlay: () => <Confetti />,
    sound: () => {
      const s = t0()
      noise(s, 0.12, { type: 'highpass', freq: 2200, gain: 0.05 })
      tone(1568, s + 0.02, 0.08, { type: 'triangle', gain: 0.05 })
      tone(1976, s + 0.08, 0.08, { type: 'triangle', gain: 0.045 })
      tone(2637, s + 0.14, 0.07, { type: 'triangle', gain: 0.04 })
    }
  },
  {
    id: 'flip',
    title: '3D card spin',
    desc: 'The card spins once on its vertical axis. Tactile.',
    keywords: ['flip', '3d', 'spin', 'rotate'],
    cardClass: 'flab-anim-flip',
    sound: () => noise(t0(), 0.3, { type: 'bandpass', freq: 300, sweepTo: 2600, gain: 0.05 })
  },
  {
    id: 'ripple',
    title: 'Ripple / radar',
    desc: 'Concentric rings expand from the center. Clean.',
    keywords: ['ripple', 'wave', 'radar', 'expand'],
    stageOverlay: () => (
      <>
        <span className="flab-ripple" aria-hidden />
        <span className="flab-ripple" style={{ animationDelay: '110ms' }} aria-hidden />
      </>
    ),
    sound: () => tone(1244, t0(), 0.5, { type: 'sine', gain: 0.07, glideTo: 880 })
  },
  {
    id: 'shake',
    title: 'Impact shake + flash',
    desc: 'A quick horizontal shake with an accent flash. Punchy.',
    keywords: ['impact', 'shake', 'punch', 'juice'],
    cardClass: 'flab-anim-shake',
    stageOverlay: () => <div className="flab-flash" aria-hidden />,
    sound: () => tone(150, t0(), 0.22, { type: 'sine', glideTo: 60, gain: 0.09 })
  },
  {
    id: 'pop',
    title: 'Spring scale pop',
    desc: 'The card springs up with an overshoot and settles. Bouncy.',
    keywords: ['spring', 'bounce', 'pop', 'scale'],
    soundNote: '#7 marimba',
    cardClass: 'flab-anim-pop',
    sound: SOUND.marimba
  },
  {
    id: 'sweep',
    title: 'Light sweep / sheen',
    desc: 'A diagonal gloss sweeps across the whole view. Slick.',
    keywords: ['shine', 'gloss', 'sweep', 'sheen'],
    soundNote: '#8 arp',
    stageOverlay: () => <div className="flab-sweep" aria-hidden />,
    sound: SOUND.sweepArp
  },
  {
    id: 'flood',
    title: 'Color flood wash',
    desc: 'An accent tint floods the whole view then fades. Warm.',
    keywords: ['flood', 'wash', 'tint', 'fill'],
    soundNote: '#9 chord',
    stageOverlay: () => <div className="flab-flood" aria-hidden />,
    sound: SOUND.chord
  },
  {
    id: 'rails',
    title: 'Side rails rise',
    desc: 'Two comets streak up the left and right view edges together. Energetic.',
    keywords: ['rails', 'streak', 'rise', 'comet'],
    stageOverlay: () => (
      <>
        <span className="flab-rail l" aria-hidden />
        <span className="flab-rail r" aria-hidden />
      </>
    ),
    sound: () => tone(330, t0(), 0.42, { type: 'triangle', glideTo: 990, gain: 0.055 })
  },
  {
    id: 'starburst',
    title: 'Starburst rays',
    desc: 'Radial rays explode outward from the center and fade. Dramatic.',
    keywords: ['rays', 'starburst', 'radiate', 'explode'],
    stageOverlay: () => <div className="flab-burst" aria-hidden />,
    sound: () => arp([784, 988, 1175, 1397, 1760], 0.045, 0.1)
  },
  {
    id: 'check',
    title: 'Checkmark draw',
    desc: 'A checkmark draws itself in the center with a final thicken. Reassuring.',
    keywords: ['check', 'tick', 'success', 'confirm'],
    soundNote: '#12 ding',
    stageOverlay: Checkmark,
    sound: SOUND.ding
  }
]

// --- tuner: a parameterized "Neon + pop + flood" (#4) -----------------------

const TUNE_DEFAULTS = {
  traceDur: 780,
  baseW: 4,
  bloomW: 8,
  glow: 16,
  traceOp: 1,
  popScale: 1.09,
  popDur: 540,
  spring: 0.56,
  floodOp: 0.22,
  floodDur: 600,
  vol: 0.06,
  soundOn: true
}
type TuneKey = keyof typeof TUNE_DEFAULTS

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  fmt?: (v: number) => string
  onChange: (v: number) => void
}): JSX.Element {
  const { label, value, min, max, step, fmt, onChange } = props
  return (
    <label className="flab-slider">
      <span className="flab-slider-top">
        <span>{label}</span>
        <span className="flab-slider-val">{fmt ? fmt(value) : value}</span>
      </span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

function Tuner(): JSX.Element {
  const [p, setP] = useState(TUNE_DEFAULTS)
  const [nonce, setNonce] = useState(0)
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const upd = (k: TuneKey) => (v: number) => setP((s) => ({ ...s, [k]: v }))

  const play = useCallback(
    (withSound: boolean): void => {
      setNonce((n) => n + 1)
      if (withSound && p.soundOn) {
        const s = t0()
        tone(1046.5, s, 0.12, { gain: p.vol })
        tone(1396.9, s + 0.1, 0.14, { gain: p.vol })
      }
    },
    [p.soundOn, p.vol]
  )

  // Auto-replay (visual only) shortly after the last slider change.
  useEffect(() => {
    if (replayTimer.current) clearTimeout(replayTimer.current)
    replayTimer.current = setTimeout(() => setNonce((n) => n + 1), 240)
    return () => {
      if (replayTimer.current) clearTimeout(replayTimer.current)
    }
  }, [p.traceDur, p.baseW, p.bloomW, p.glow, p.traceOp, p.popScale, p.popDur, p.spring, p.floodOp, p.floodDur])

  const popEase = `cubic-bezier(.34, ${(1 + p.spring).toFixed(2)}, .64, 1)`

  return (
    <section className="flab-tuner">
      <div className="flab-section-head">
        <h2 className="flab-h2">Tuner — Neon + pop + flood (#4)</h2>
        <span className="flab-section-sub">drag to dial it in · auto-replays · ▶ replays with sound</span>
      </div>

      <div className="flab-stage" style={{ minHeight: 260 }}>
        <div
          key={nonce}
          className="flab-card"
          style={vars({ '--pop-scale': p.popScale, animation: `flab-tune-pop ${p.popDur}ms ${popEase} both` })}
        >
          <div className="flab-card-bg">
            <div
              style={vars({
                position: 'absolute',
                inset: 0,
                background: 'rgb(var(--z-accent))',
                '--flood-op': p.floodOp,
                animation: `flab-tune-flood ${p.floodDur}ms ease-out both`
              })}
            />
          </div>
          <div className="flab-card-kicker flab-z">RECALL · CONCEPT</div>
          <div className="flab-card-body flab-z">A spaced-repetition card</div>
          <div className="flab-card-foot flab-z">Good · Easy</div>
          <div className="flab-card-edge">
            <svg className="flab-card-trace" aria-hidden>
              <rect
                x="0"
                y="0"
                width="100%"
                height="100%"
                rx="14"
                pathLength={100}
                style={vars({
                  stroke: `rgb(var(--z-accent) / ${p.traceOp})`,
                  strokeDasharray: 100,
                  filter: `drop-shadow(0 0 ${p.glow}px rgb(var(--z-accent) / .9)) drop-shadow(0 0 ${p.glow * 2}px rgb(var(--z-accent) / .5))`,
                  '--base-w': p.baseW,
                  '--bloom-w': p.bloomW,
                  animation: `flab-tune-trace ${p.traceDur}ms cubic-bezier(.3,0,.2,1) both`
                })}
              />
            </svg>
          </div>
        </div>
      </div>

      <div className="flab-tuner-grid">
        <Slider label="Trace duration" value={p.traceDur} min={300} max={1400} step={20} fmt={(v) => `${v}ms`} onChange={upd('traceDur')} />
        <Slider label="Stroke width" value={p.baseW} min={1} max={8} step={0.5} fmt={(v) => `${v}px`} onChange={upd('baseW')} />
        <Slider label="Bloom width" value={p.bloomW} min={2} max={16} step={0.5} fmt={(v) => `${v}px`} onChange={upd('bloomW')} />
        <Slider label="Glow radius" value={p.glow} min={0} max={40} step={1} fmt={(v) => `${v}px`} onChange={upd('glow')} />
        <Slider label="Trace opacity" value={p.traceOp} min={0.3} max={1} step={0.05} fmt={(v) => v.toFixed(2)} onChange={upd('traceOp')} />
        <Slider label="Pop scale" value={p.popScale} min={1} max={1.3} step={0.005} fmt={(v) => v.toFixed(3)} onChange={upd('popScale')} />
        <Slider label="Pop duration" value={p.popDur} min={200} max={900} step={20} fmt={(v) => `${v}ms`} onChange={upd('popDur')} />
        <Slider label="Spring overshoot" value={p.spring} min={0} max={1.1} step={0.02} fmt={(v) => v.toFixed(2)} onChange={upd('spring')} />
        <Slider label="Flood opacity" value={p.floodOp} min={0} max={0.5} step={0.01} fmt={(v) => v.toFixed(2)} onChange={upd('floodOp')} />
        <Slider label="Flood duration" value={p.floodDur} min={200} max={1000} step={20} fmt={(v) => `${v}ms`} onChange={upd('floodDur')} />
        <Slider label="Sound volume" value={p.vol} min={0} max={0.15} step={0.005} fmt={(v) => v.toFixed(3)} onChange={upd('vol')} />
      </div>

      <div className="flab-tuner-actions">
        <button type="button" className="flab-play" onClick={() => play(true)}>
          ▶ Play with sound
        </button>
        <label className="flab-check-lbl">
          <input type="checkbox" checked={p.soundOn} onChange={(e) => setP((s) => ({ ...s, soundOn: e.target.checked }))} />
          sound on
        </label>
        <button type="button" className="flab-play flab-play-ghost" onClick={() => setP(TUNE_DEFAULTS)}>
          Reset
        </button>
      </div>

      <pre className="flab-config">
        {[
          `trace:  dur ${p.traceDur}ms · stroke ${p.baseW}px · bloom ${p.bloomW}px · glow ${p.glow}px · opacity ${p.traceOp}`,
          `pop:    scale ${p.popScale} · dur ${p.popDur}ms · spring ${p.spring}  (ease ${popEase})`,
          `flood:  opacity ${p.floodOp} · dur ${p.floodDur}ms`,
          `sound:  ${p.soundOn ? 'on' : 'off'} · volume ${p.vol}`
        ].join('\n')}
      </pre>
    </section>
  )
}

// --- component --------------------------------------------------------------

export function FeedbackLab(): JSX.Element {
  const [active, setActive] = useState<{ id: string; nonce: number } | null>(null)
  const nonce = useRef(0)

  const trigger = (p: Pattern): void => {
    nonce.current += 1
    setActive({ id: p.id, nonce: nonce.current })
    try {
      p.sound()
    } catch {
      // audio is best-effort
    }
  }

  const all = useMemo(() => [...ROUND4, ...CARD_CIRCUIT, ...COMBOS, ...ORIGINALS], [])
  const pat = active ? all.find((p) => p.id === active.id) : undefined
  const cardClass = pat?.cardClass ?? ''
  const textClass = pat?.textClass ?? ''
  const k = active?.nonce ?? 0

  const renderGroup = (title: string, subtitle: string, patterns: Pattern[]): JSX.Element => (
    <section className="flab-section">
      <div className="flab-section-head">
        <h2 className="flab-h2">{title}</h2>
        <span className="flab-section-sub">{subtitle}</span>
      </div>
      <div className="flab-grid">
        {patterns.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={`flab-btn${active?.id === p.id ? ' is-active' : ''}`}
            onClick={() => trigger(p)}
          >
            <span className="flab-btn-head">
              <span className="flab-num">{i + 1}</span>
              <span className="flab-btn-title">{p.title}</span>
              {p.soundNote && <span className="flab-sound">{p.soundNote}</span>}
            </span>
            <span className="flab-desc">{p.desc}</span>
            <span className="flab-keys">
              {p.keywords.map((kw) => (
                <span key={kw} className="flab-key">
                  {kw}
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </section>
  )

  return (
    <div className="flab-root">
      <style>{CSS}</style>

      <header className="flab-header">
        <h1 className="flab-title">Feedback Lab</h1>
        <p className="flab-sub">
          Temporary playground. Click a pattern to preview its visual + sound on the mock card
          below. Uses the current theme accent. Re-click to replay. Sound badges (e.g.{' '}
          <code>#7 marimba</code>) mark your favorites.
        </p>
      </header>

      <Tuner />

      <div className="flab-stage">
        <div key={`card-${k}`} className={`flab-card ${cardClass}`}>
          {pat?.cardBg && <div className="flab-card-bg">{pat.cardBg()}</div>}
          <div className="flab-card-kicker flab-z">RECALL · CONCEPT</div>
          <div className={`flab-card-body flab-z ${textClass}`}>A spaced-repetition card</div>
          <div className="flab-card-foot flab-z">Good · Easy</div>
          {pat?.cardEdge && <div className="flab-card-edge">{pat.cardEdge()}</div>}
        </div>
        {pat?.stageOverlay && (
          <div key={`stage-${k}`} className="flab-overlay" aria-hidden>
            {pat.stageOverlay()}
          </div>
        )}
      </div>

      {renderGroup('Round 4 — circuit · pop · flood · neon', '6 combinations · all use #1 chime', ROUND4)}
      {renderGroup('Round 3 — card border circuit combos', '11 patterns · the favorite, combined', CARD_CIRCUIT)}
      {renderGroup('Round 2 — combinations & surfaces', '14 patterns · view, card border, background, text', COMBOS)}
      {renderGroup('Round 1 — originals', '12 patterns · for comparison', ORIGINALS)}
    </div>
  )
}

// --- all styles, inline so this file is fully self-contained ----------------

const CSS = `
.flab-root{height:100%;overflow:auto;background:rgb(var(--z-bg));color:rgb(var(--z-fg));
  padding:28px;max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:22px}
.flab-header{display:flex;flex-direction:column;gap:6px}
.flab-title{font-size:20px;font-weight:650;margin:0}
.flab-sub{font-size:13px;line-height:1.5;color:rgb(var(--z-fg) / 0.62);margin:0;max-width:680px}
.flab-sub code{font-size:11px;padding:1px 5px;border-radius:5px;background:rgb(var(--z-fg) / 0.07)}

.flab-stage{position:relative;overflow:hidden;border-radius:16px;
  border:1px solid rgb(var(--z-fg) / 0.12);background:rgb(var(--z-fg) / 0.02);
  min-height:300px;display:flex;align-items:center;justify-content:center}
.flab-card{position:relative;z-index:1;width:60%;max-width:380px;border-radius:14px;
  padding:30px 26px;text-align:center;background:rgb(var(--z-fg) / 0.04);
  border:1px solid rgb(var(--z-fg) / 0.12);transform-origin:center}
.flab-z{position:relative;z-index:1}
.flab-card-kicker{font-size:10px;letter-spacing:.14em;color:rgb(var(--z-accent));font-weight:600}
.flab-card-body{margin-top:10px;font-size:16px;font-weight:550;display:inline-block}
.flab-card-foot{margin-top:14px;font-size:11px;color:rgb(var(--z-fg) / 0.5)}
.flab-card-bg{position:absolute;inset:0;border-radius:14px;overflow:hidden;z-index:0}
.flab-card-edge{position:absolute;inset:0;z-index:2;pointer-events:none}
.flab-overlay{position:absolute;inset:0;pointer-events:none;z-index:3}

/* tuner */
.flab-tuner{display:flex;flex-direction:column;gap:14px;padding:16px 18px;border-radius:16px;
  border:1px solid rgb(var(--z-accent) / 0.32);background:rgb(var(--z-accent) / 0.04)}
.flab-tuner-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px 22px}
.flab-slider{display:flex;flex-direction:column;gap:5px}
.flab-slider-top{display:flex;justify-content:space-between;font-size:12px;color:rgb(var(--z-fg) / 0.7)}
.flab-slider-val{color:rgb(var(--z-accent));font-variant-numeric:tabular-nums;font-weight:600}
.flab-slider input{width:100%;accent-color:rgb(var(--z-accent))}
.flab-tuner-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.flab-play{padding:8px 18px;border-radius:10px;border:1px solid rgb(var(--z-accent) / 0.5);
  background:rgb(var(--z-accent) / 0.14);color:rgb(var(--z-accent));font-weight:650;font-size:13px;cursor:pointer}
.flab-play:hover{background:rgb(var(--z-accent) / 0.22)}
.flab-play-ghost{background:transparent;color:rgb(var(--z-fg) / 0.6);border-color:rgb(var(--z-fg) / 0.2)}
.flab-check-lbl{display:flex;align-items:center;gap:6px;font-size:12px;color:rgb(var(--z-fg) / 0.7)}
.flab-config{font-size:11px;line-height:1.6;white-space:pre-wrap;margin:0;
  background:rgb(var(--z-fg) / 0.05);padding:10px 12px;border-radius:8px;color:rgb(var(--z-fg) / 0.72);overflow:auto}
@keyframes flab-tune-trace{0%{stroke-dashoffset:100;opacity:0;stroke-width:var(--base-w)}10%{opacity:1}
  70%{stroke-dashoffset:0;stroke-width:var(--base-w)}82%{stroke-width:var(--bloom-w)}92%{stroke-width:var(--base-w)}100%{stroke-dashoffset:0;opacity:0}}
@keyframes flab-tune-pop{0%{transform:scale(1)}32%{transform:scale(var(--pop-scale))}100%{transform:scale(1)}}
@keyframes flab-tune-flood{0%{opacity:0}22%{opacity:var(--flood-op)}60%{opacity:calc(var(--flood-op) * .8)}100%{opacity:0}}

.flab-section{display:flex;flex-direction:column;gap:12px}
.flab-section-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
  border-bottom:1px solid rgb(var(--z-fg) / 0.1);padding-bottom:8px}
.flab-h2{font-size:14px;font-weight:650;margin:0}
.flab-section-sub{font-size:12px;color:rgb(var(--z-fg) / 0.5)}
.flab-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(262px,1fr));gap:12px}
.flab-btn{display:flex;flex-direction:column;gap:8px;text-align:left;cursor:pointer;
  padding:14px 16px;border-radius:12px;background:rgb(var(--z-fg) / 0.03);
  border:1px solid rgb(var(--z-fg) / 0.12);transition:border-color .12s,background .12s}
.flab-btn:hover{background:rgb(var(--z-accent) / 0.08);border-color:rgb(var(--z-accent) / 0.45)}
.flab-btn:active{transform:translateY(1px)}
.flab-btn.is-active{border-color:rgb(var(--z-accent) / 0.7);background:rgb(var(--z-accent) / 0.07)}
.flab-btn-head{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.flab-btn-title{flex:1;min-width:0}
.flab-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;
  border-radius:6px;background:rgb(var(--z-accent) / 0.14);color:rgb(var(--z-accent));
  font-size:11px;font-weight:700;flex:none}
.flab-sound{font-size:10px;padding:2px 7px;border-radius:999px;flex:none;
  background:rgb(var(--z-accent) / 0.12);color:rgb(var(--z-accent));font-weight:600}
.flab-desc{font-size:12px;line-height:1.45;color:rgb(var(--z-fg) / 0.6)}
.flab-keys{display:flex;flex-wrap:wrap;gap:5px}
.flab-key{font-size:10px;padding:2px 7px;border-radius:999px;
  background:rgb(var(--z-fg) / 0.06);color:rgb(var(--z-fg) / 0.6)}

/* view border circuit */
.flab-circuit{width:100%;height:100%;overflow:visible;transform:rotate(180deg)}
.flab-circuit rect{fill:none;stroke:rgb(var(--z-accent));stroke-width:3;stroke-dasharray:100;
  stroke-linejoin:round;filter:drop-shadow(0 0 4px rgb(var(--z-accent) / .9)) drop-shadow(0 0 10px rgb(var(--z-accent) / .5));
  animation:flab-draw 560ms cubic-bezier(.3,0,.2,1) both}
@keyframes flab-draw{0%{stroke-dashoffset:100;opacity:0}10%{opacity:1}
  68%{stroke-dashoffset:0;stroke-width:3}78%{stroke-width:6}88%{stroke-width:3}100%{stroke-dashoffset:0;opacity:0}}

/* card border circuit (rounded) */
.flab-card-trace{position:absolute;inset:0;width:100%;height:100%;overflow:visible;transform:rotate(180deg)}
.flab-card-trace rect{fill:none;stroke:rgb(var(--z-accent));stroke-width:2.5;stroke-dasharray:100;
  filter:drop-shadow(0 0 4px rgb(var(--z-accent) / .85)) drop-shadow(0 0 8px rgb(var(--z-accent) / .45));
  animation:flab-draw-card 520ms cubic-bezier(.3,0,.2,1) both}
@keyframes flab-draw-card{0%{stroke-dashoffset:100;opacity:0}10%{opacity:1}
  68%{stroke-dashoffset:0;stroke-width:2.5}78%{stroke-width:4.5}88%{stroke-width:2.5}100%{stroke-dashoffset:0;opacity:0}}

/* neon card circuit — thicker, slower, heavy bloom */
.flab-card-trace.neon rect{stroke-width:4;
  filter:drop-shadow(0 0 6px rgb(var(--z-accent))) drop-shadow(0 0 16px rgb(var(--z-accent) / .7)) drop-shadow(0 0 32px rgb(var(--z-accent) / .4));
  animation:flab-draw-neon 780ms cubic-bezier(.3,0,.2,1) both}
@keyframes flab-draw-neon{0%{stroke-dashoffset:100;opacity:0}10%{opacity:1}
  70%{stroke-dashoffset:0;stroke-width:4}82%{stroke-width:8}92%{stroke-width:4}100%{stroke-dashoffset:0;opacity:0}}

/* card outline pulse ring */
.flab-card-ring{position:absolute;inset:0;border-radius:14px;border:2px solid rgb(var(--z-accent));
  animation:flab-card-ring 620ms ease-out both}
@keyframes flab-card-ring{0%{opacity:0;box-shadow:0 0 0 0 rgb(var(--z-accent) / .45)}
  28%{opacity:1;box-shadow:0 0 0 7px rgb(var(--z-accent) / 0)}100%{opacity:0;box-shadow:0 0 0 9px rgb(var(--z-accent) / 0)}}

/* card edge halo */
.flab-card-halo{position:absolute;inset:0;border-radius:14px;animation:flab-card-halo 700ms ease-out both}
@keyframes flab-card-halo{0%{box-shadow:inset 0 0 0 1px rgb(var(--z-accent) / 0),0 0 0 0 rgb(var(--z-accent) / 0)}
  32%{box-shadow:inset 0 0 18px rgb(var(--z-accent) / .4),0 0 26px rgb(var(--z-accent) / .4)}
  100%{box-shadow:inset 0 0 0 1px rgb(var(--z-accent) / 0),0 0 0 0 rgb(var(--z-accent) / 0)}}

/* card background flood */
.flab-card-flood{position:absolute;inset:0;background:rgb(var(--z-accent) / .22);animation:flab-flood 600ms ease-out both}

/* deeper, longer flood (round 4) */
.flab-card-flood-deep{position:absolute;inset:0;background:rgb(var(--z-accent) / .34);animation:flab-flood-deep 760ms ease-out both}
@keyframes flab-flood-deep{0%{opacity:0}22%{opacity:1}60%{opacity:.85}100%{opacity:0}}

/* bigger overshoot pop (round 4) */
.flab-anim-pop-big{animation:flab-pop-big 600ms cubic-bezier(.34,1.7,.6,1) both}
@keyframes flab-pop-big{0%{transform:scale(1)}32%{transform:scale(1.13)}100%{transform:scale(1)}}

/* card sheen (clipped by .flab-card-bg) */
.flab-card-sheen{position:absolute;inset:0;
  background:linear-gradient(115deg,transparent 35%,rgb(var(--z-accent) / .3) 50%,transparent 65%);
  transform:translateX(-130%);animation:flab-sweep 600ms ease-in-out both}

/* text effects */
.flab-text-ignite{animation:flab-text-ignite 600ms ease-out both}
@keyframes flab-text-ignite{0%{text-shadow:0 0 0 rgb(var(--z-accent) / 0);transform:scale(1)}
  30%{text-shadow:0 0 14px rgb(var(--z-accent) / .85);color:rgb(var(--z-accent));transform:scale(1.07)}
  100%{text-shadow:0 0 0 rgb(var(--z-accent) / 0);transform:scale(1)}}
.flab-text-flash{animation:flab-text-flash 520ms ease-out both}
@keyframes flab-text-flash{30%{color:rgb(var(--z-accent))}}
.flab-text-underline{background-image:linear-gradient(rgb(var(--z-accent)),rgb(var(--z-accent)));
  background-repeat:no-repeat;background-position:0 100%;background-size:0% 2px;animation:flab-underline 560ms ease-out both}
@keyframes flab-underline{0%{background-size:0% 2px}65%{background-size:100% 2px}100%{background-size:100% 2px}}

/* card lift / depth */
.flab-anim-lift{animation:flab-lift 580ms cubic-bezier(.34,1.3,.64,1) both}
@keyframes flab-lift{0%{transform:translateY(0) scale(1);box-shadow:0 0 0 rgb(var(--z-accent) / 0)}
  36%{transform:translateY(-7px) scale(1.03);box-shadow:0 18px 40px -12px rgb(var(--z-accent) / .55)}
  100%{transform:translateY(0) scale(1);box-shadow:0 0 0 rgb(var(--z-accent) / 0)}}

/* progress bar */
.flab-progress{position:absolute;left:0;bottom:0;height:4px;width:0;background:rgb(var(--z-accent));
  box-shadow:0 0 10px rgb(var(--z-accent) / .7);animation:flab-progress 540ms cubic-bezier(.3,0,.2,1) both}
@keyframes flab-progress{0%{width:0}82%{width:100%;opacity:1}100%{width:100%;opacity:0}}

/* view edge glow */
.flab-edge{position:absolute;inset:0;border-radius:16px;animation:flab-edge 700ms ease-out both}
@keyframes flab-edge{0%{box-shadow:inset 0 0 0 2px rgb(var(--z-accent) / 0),inset 0 0 30px rgb(var(--z-accent) / 0)}
  30%{box-shadow:inset 0 0 0 2px rgb(var(--z-accent) / .7),inset 0 0 55px rgb(var(--z-accent) / .35)}
  100%{box-shadow:inset 0 0 0 2px rgb(var(--z-accent) / 0),inset 0 0 60px rgb(var(--z-accent) / 0)}}

/* confetti */
.flab-confetti-pc{position:absolute;left:50%;top:50%;width:9px;height:9px;border-radius:2px;
  will-change:transform,opacity;animation:flab-confetti 820ms ease-out both}
@keyframes flab-confetti{0%{transform:translate(-50%,-50%) scale(.4);opacity:0}
  12%{opacity:1}100%{transform:translate(-50%,-50%) translate(var(--dx),var(--dy)) rotate(var(--rot)) scale(1);opacity:0}}

/* flip */
.flab-anim-flip{animation:flab-flip 540ms cubic-bezier(.45,0,.2,1) both}
@keyframes flab-flip{0%{transform:perspective(900px) rotateY(0)}100%{transform:perspective(900px) rotateY(360deg)}}

/* ripple */
.flab-ripple{position:absolute;left:50%;top:50%;width:40px;height:40px;margin:-20px 0 0 -20px;
  border-radius:999px;border:3px solid rgb(var(--z-accent) / .8);animation:flab-ripple 680ms ease-out both}
@keyframes flab-ripple{0%{transform:scale(.2);opacity:.9;border-width:4px}100%{transform:scale(13);opacity:0;border-width:1px}}

/* shake + flash */
.flab-anim-shake{animation:flab-shake 430ms cubic-bezier(.36,.07,.19,.97) both}
@keyframes flab-shake{10%{transform:translateX(-7px)}20%{transform:translateX(7px)}30%{transform:translateX(-5px)}
  40%{transform:translateX(5px)}50%{transform:translateX(-3px)}60%{transform:translateX(3px)}70%{transform:translateX(-2px)}100%{transform:translateX(0)}}
.flab-flash{position:absolute;inset:0;background:rgb(var(--z-accent) / .18);animation:flab-flash 320ms ease-out both}
@keyframes flab-flash{0%{opacity:0}18%{opacity:1}100%{opacity:0}}

/* spring pop */
.flab-anim-pop{animation:flab-pop 540ms cubic-bezier(.34,1.56,.64,1) both}
@keyframes flab-pop{0%{transform:scale(1)}30%{transform:scale(1.09)}100%{transform:scale(1)}}

/* sweep */
.flab-sweep{position:absolute;inset:0;
  background:linear-gradient(115deg,transparent 32%,rgb(var(--z-accent) / .28) 50%,transparent 68%);
  transform:translateX(-130%);animation:flab-sweep 620ms ease-in-out both}
@keyframes flab-sweep{0%{transform:translateX(-130%)}100%{transform:translateX(130%)}}

/* flood */
.flab-flood{position:absolute;inset:0;background:rgb(var(--z-accent) / .22);animation:flab-flood 600ms ease-out both}
@keyframes flab-flood{0%{opacity:0}25%{opacity:1}100%{opacity:0}}

/* rails */
.flab-rail{position:absolute;top:0;width:4px;height:40%;
  background:linear-gradient(to top,rgb(var(--z-accent) / 0),rgb(var(--z-accent)));
  box-shadow:0 0 12px rgb(var(--z-accent) / .9),0 0 26px rgb(var(--z-accent) / .5);
  animation:flab-rail 560ms cubic-bezier(.4,0,.2,1) both}
.flab-rail.l{left:0}.flab-rail.r{right:0}
@keyframes flab-rail{0%{transform:translateY(250%);opacity:0}12%{opacity:1}100%{transform:translateY(-100%);opacity:0}}

/* starburst */
.flab-burst{position:absolute;left:50%;top:50%;width:80px;height:80px;margin:-40px 0 0 -40px;border-radius:999px;
  background:repeating-conic-gradient(rgb(var(--z-accent) / .6) 0deg 5deg, transparent 5deg 22deg);
  -webkit-mask:radial-gradient(circle, #000 30%, transparent 70%);mask:radial-gradient(circle, #000 30%, transparent 70%);
  animation:flab-burst 580ms ease-out both}
@keyframes flab-burst{0%{transform:scale(.2) rotate(0);opacity:0}25%{opacity:1}100%{transform:scale(7) rotate(38deg);opacity:0}}

/* checkmark */
.flab-check{position:absolute;left:50%;top:50%;width:120px;height:120px;margin:-60px 0 0 -60px}
.flab-check.sm{width:78px;height:78px;margin:-39px 0 0 -39px}
.flab-check path{fill:none;stroke:rgb(var(--z-accent));stroke-width:9;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:100;filter:drop-shadow(0 0 6px rgb(var(--z-accent) / .55));animation:flab-checkdraw 540ms cubic-bezier(.3,0,.2,1) both}
@keyframes flab-checkdraw{0%{stroke-dashoffset:100;opacity:0}15%{opacity:1}70%{stroke-dashoffset:0;stroke-width:9}85%{stroke-width:13}100%{stroke-dashoffset:0;opacity:0}}

@media (prefers-reduced-motion: reduce){
  .flab-circuit rect,.flab-card-trace rect,.flab-card-trace.neon rect,.flab-card-ring,.flab-card-halo,.flab-card-flood,.flab-card-flood-deep,.flab-anim-pop-big,.flab-card-sheen,
  .flab-text-ignite,.flab-text-flash,.flab-text-underline,.flab-anim-lift,.flab-progress,
  .flab-edge,.flab-confetti-pc,.flab-anim-flip,.flab-ripple,.flab-anim-shake,.flab-flash,.flab-anim-pop,
  .flab-sweep,.flab-flood,.flab-rail,.flab-burst,.flab-check path{animation-duration:1ms}
}
`
