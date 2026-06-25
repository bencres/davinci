import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import {
  localDateKey,
  type CalibrationStats,
  type ConceptMastery,
  type HeatmapDay
} from '@shared/study-stats'
import type { ConceptGap, GapReason } from '@shared/concept-graph'
import { TargetIcon, ZapIcon } from './icons'

interface Props {
  isActive: boolean
}

/** Outer scroll container, matching the StudyView shell width/padding. */
function DashboardShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-paper-100">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-6 py-8">
        {children}
      </div>
    </div>
  )
}

/** A circular progress ring (today's reviews vs. the daily goal). */
function GoalRing({ value, goal }: { value: number; goal: number }): JSX.Element {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0
  const r = 34
  const c = 2 * Math.PI * r
  const offset = c * (1 - pct)
  const done = value >= goal
  return (
    <svg width="84" height="84" viewBox="0 0 84 84" className="shrink-0">
      <circle cx="42" cy="42" r={r} fill="none" strokeWidth="8" className="stroke-paper-300" />
      <circle
        cx="42"
        cy="42"
        r={r}
        fill="none"
        strokeWidth="8"
        strokeLinecap="round"
        className={done ? 'stroke-emerald-500' : 'stroke-accent'}
        strokeDasharray={c}
        strokeDashoffset={offset}
        transform="rotate(-90 42 42)"
      />
      <text
        x="42"
        y="39"
        textAnchor="middle"
        className="fill-ink-800 text-[15px] font-semibold"
      >
        {value}
      </text>
      <text x="42" y="55" textAnchor="middle" className="fill-ink-500 text-[10px]">
        / {goal}
      </text>
    </svg>
  )
}

/** A labelled headline number. */
function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-paper-300 bg-paper-50 px-4 py-3">
      <span className="text-2xs font-medium uppercase tracking-[0.12em] text-ink-500">{label}</span>
      <span className="text-xl font-semibold text-ink-800">{value}</span>
      {hint && <span className="text-2xs text-ink-500">{hint}</span>}
    </div>
  )
}

/** Tailwind intensity class for a heatmap day's review count. */
function heatTone(count: number): string {
  if (count <= 0) return 'bg-paper-300'
  if (count < 3) return 'bg-accent/25'
  if (count < 6) return 'bg-accent/45'
  if (count < 10) return 'bg-accent/70'
  return 'bg-accent'
}

/** Weekday (0=Sun) for a `YYYY-MM-DD` key, parsed in local time. */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getDay()
}

/** GitHub-style activity grid: columns are calendar weeks (Sun→Sat). */
function Heatmap({ days }: { days: HeatmapDay[] }): JSX.Element {
  const weeks = useMemo(() => {
    const cols: (HeatmapDay | null)[][] = []
    let col: (HeatmapDay | null)[] = []
    for (const day of days) {
      const wd = weekdayOf(day.date)
      if (wd === 0 && col.length > 0) {
        cols.push(col)
        col = []
      }
      // Pad the first column so the first day sits on its true weekday row.
      if (col.length === 0 && cols.length === 0) {
        for (let i = 0; i < wd; i++) col.push(null)
      }
      col.push(day)
    }
    if (col.length > 0) cols.push(col)
    return cols
  }, [days])

  return (
    <div className="flex gap-[3px] overflow-x-auto pb-1">
      {weeks.map((col, ci) => (
        <div key={ci} className="flex flex-col gap-[3px]">
          {Array.from({ length: 7 }).map((_, ri) => {
            const day = col[ri]
            if (!day) return <div key={ri} className="h-[11px] w-[11px]" />
            return (
              <div
                key={ri}
                className={`h-[11px] w-[11px] rounded-[2px] ${heatTone(day.count)}`}
                title={`${day.date}: ${day.count} review${day.count === 1 ? '' : 's'}`}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** One concept's mastery bar; clickable when it maps to a single note. */
function ConceptRow({ concept }: { concept: ConceptMastery }): JSX.Element {
  const startStudySession = useStore((s) => s.startStudySession)
  const single = concept.notePaths.length === 1 ? concept.notePaths[0] : null
  const accuracyPct = Math.round(concept.accuracy * 100)
  return (
    <button
      type="button"
      disabled={!single}
      onClick={() => single && void startStudySession({ kind: 'note', notePath: single })}
      className={[
        'flex w-full flex-col gap-1.5 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-left',
        single ? 'hover:border-accent/40 hover:bg-accent/5' : 'cursor-default'
      ].join(' ')}
      title={single ? `Study “${concept.concept}”` : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium text-ink-800">{concept.concept}</span>
        <span className="shrink-0 text-2xs text-ink-500">
          {concept.mature}/{concept.total} mastered
          {concept.total > 0 && accuracyPct > 0 ? ` · ${accuracyPct}% acc` : ''}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-paper-300">
        <div
          className="h-full rounded-full bg-accent transition-[width]"
          style={{ width: `${concept.masteryPct}%` }}
        />
      </div>
    </button>
  )
}

/** A signed bias bar centered at zero: under-confident (left) ↔ over-confident (right). */
function BiasBar({ bias }: { bias: number }): JSX.Element {
  const clamped = Math.max(-2, Math.min(2, bias)) // ratings span 1–4, so |bias| ≤ 3; clamp for display
  const half = (Math.abs(clamped) / 2) * 50 // 0..50% of the track width
  const over = clamped > 0
  return (
    <div className="relative h-2 w-full rounded-full bg-paper-300">
      {/* center tick */}
      <div className="absolute left-1/2 top-[-2px] h-3 w-px -translate-x-1/2 bg-ink-400" />
      {Math.abs(clamped) > 0.01 && (
        <div
          className={`absolute top-0 h-full ${over ? 'rounded-r-full bg-amber-500' : 'rounded-l-full bg-sky-500'}`}
          style={over ? { left: '50%', width: `${half}%` } : { right: '50%', width: `${half}%` }}
        />
      )}
    </div>
  )
}

/** Predicted-vs-actual calibration: how well self-predictions matched real grades. */
function CalibrationCard({ c }: { c: CalibrationStats }): JSX.Element {
  const bias = c.signedBias
  const abs = Math.abs(bias)
  const verdict = abs < 0.25 ? 'Well calibrated' : bias > 0 ? 'Over-confident' : 'Under-confident'
  const tone = abs < 0.25 ? 'text-emerald-700' : bias > 0 ? 'text-amber-700' : 'text-sky-700'
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink-800">Calibration</h2>
      <div className="flex flex-col gap-3 rounded-xl border border-paper-300 bg-paper-50 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-sm font-semibold ${tone}`}>{verdict}</span>
          <span className="text-2xs text-ink-500">
            avg error {c.meanAbsError.toFixed(2)} / 3 · {c.sampleSize} reviews
          </span>
        </div>
        <BiasBar bias={bias} />
        <div className="flex items-center justify-between text-2xs text-ink-500">
          <span>under-confident</span>
          <span>over-confident</span>
        </div>
        {c.recent.sampleSize > 0 && c.recent.sampleSize < c.sampleSize && (
          <p className="text-2xs text-ink-500">
            Recent {c.recent.sampleSize}: error {c.recent.meanAbsError.toFixed(2)}, bias{' '}
            {c.recent.signedBias >= 0 ? '+' : ''}
            {c.recent.signedBias.toFixed(2)}
          </p>
        )}
      </div>
    </section>
  )
}

const GAP_LABEL: Record<GapReason, string> = {
  'unmet-prereq': 'weak foundation',
  'orphan-prereq': 'no cards yet',
  weak: 'needs review'
}

/** "Shore up" list: weakest / unmet-prerequisite concepts, click to study. */
function GapsSection({ gaps }: { gaps: ConceptGap[] }): JSX.Element {
  const startStudySession = useStore((s) => s.startStudySession)
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink-800">Shore up these gaps</h2>
      <div className="flex flex-col gap-2">
        {gaps.slice(0, 8).map((g) => {
          // Untaught prerequisites have no cards to study yet.
          const studyable = g.reason !== 'orphan-prereq'
          return (
            <button
              key={g.key}
              type="button"
              disabled={!studyable}
              onClick={() => studyable && void startStudySession({ kind: 'concept', concept: g.concept })}
              className={[
                'flex items-center justify-between gap-2 rounded-lg border border-paper-300 bg-paper-50 px-3 py-2 text-left',
                studyable ? 'hover:border-amber-400/60 hover:bg-amber-500/5' : 'cursor-default opacity-80'
              ].join(' ')}
              title={studyable ? `Study “${g.concept}”` : `“${g.concept}” has no cards yet`}
            >
              <span className="truncate text-sm font-medium text-ink-800">{g.concept}</span>
              <span className="flex shrink-0 items-center gap-2 text-2xs text-ink-500">
                {g.reason !== 'orphan-prereq' && <span>{g.masteryPct}% mastery</span>}
                <span className="rounded-full bg-amber-500/12 px-2 py-0.5 font-medium text-amber-700">
                  {GAP_LABEL[g.reason]}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/** The gamified study hub: streak, goal ring, activity heatmap, concept mastery. */
export function StudyDashboard({ isActive }: Props): JSX.Element {
  const stats = useStore((s) => s.studyStats)
  const loading = useStore((s) => s.studyStatsLoading)
  const error = useStore((s) => s.studyStatsError)
  const loadStudyStats = useStore((s) => s.loadStudyStats)
  const setStudyDailyGoal = useStore((s) => s.setStudyDailyGoal)
  const startStudySession = useStore((s) => s.startStudySession)
  const conceptGraph = useStore((s) => s.conceptGraph)
  const loadConceptGraph = useStore((s) => s.loadConceptGraph)

  // Refresh whenever this tab becomes the active one (cheap; reads deck/log files).
  useEffect(() => {
    if (isActive) {
      void loadStudyStats()
      void loadConceptGraph() // powers the "shore up" gaps list
    }
  }, [isActive, loadStudyStats, loadConceptGraph])

  const [editingGoal, setEditingGoal] = useState(false)
  const [goalDraft, setGoalDraft] = useState('')

  if (!stats) {
    return (
      <DashboardShell>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          {error ? <span className="text-rose-600">{error}</span> : loading ? 'Loading your stats…' : '…'}
        </div>
      </DashboardShell>
    )
  }

  const hasCards = stats.totalCards > 0
  const pending = stats.dueToday + stats.newAvailable

  const commitGoal = (): void => {
    const n = Number(goalDraft)
    if (Number.isFinite(n) && n > 0) void setStudyDailyGoal(n)
    setEditingGoal(false)
  }

  return (
    <DashboardShell>
      {/* ---- Start-studying hero (primary entry point) ---- */}
      <div className="flex flex-col gap-3 rounded-2xl border border-accent/20 bg-accent/5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-ink-900">Study</h1>
          {!hasCards ? (
            <p className="text-sm text-ink-500">
              Generate flashcards from a note to start building your streak.
            </p>
          ) : pending > 0 ? (
            <p className="text-sm text-ink-600">
              <span className="font-medium text-ink-800">{stats.dueToday}</span> due
              {stats.newAvailable > 0 && (
                <>
                  {' · '}
                  <span className="font-medium text-ink-800">{stats.newAvailable}</span> new
                </>
              )}{' '}
              waiting for you.
            </p>
          ) : (
            <p className="text-sm text-emerald-700">You’re all caught up for today 🎉</p>
          )}
        </div>
        {hasCards && (
          <button
            type="button"
            onClick={() => void startStudySession({ kind: 'all' })}
            className="shrink-0 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent/90"
          >
            {pending > 0 ? 'Start studying' : 'Study anyway'}
          </button>
        )}
      </div>

      {/* ---- Streak + goal ring + headline stats ---- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex items-center gap-3 rounded-xl border border-paper-300 bg-paper-50 px-4 py-3">
          <span className="text-2xl" aria-hidden>🔥</span>
          <div className="flex flex-col">
            <span className="text-xl font-semibold text-ink-800">{stats.currentStreak}</span>
            <span className="text-2xs text-ink-500">day streak</span>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-paper-300 bg-paper-50 px-4 py-3">
          <GoalRing value={stats.reviewsToday} goal={stats.dailyGoal} />
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-[0.12em] text-ink-500">
              <TargetIcon className="h-3 w-3" /> daily goal
            </span>
            {editingGoal ? (
              <input
                type="number"
                min={1}
                autoFocus
                value={goalDraft}
                onChange={(e) => setGoalDraft(e.target.value)}
                onBlur={commitGoal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitGoal()
                  if (e.key === 'Escape') setEditingGoal(false)
                }}
                className="w-16 rounded border border-paper-300 bg-paper-100 px-1 py-0.5 text-sm text-ink-800"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setGoalDraft(String(stats.dailyGoal))
                  setEditingGoal(true)
                }}
                className="text-left text-sm text-ink-600 hover:text-accent"
              >
                {stats.dailyGoal} cards/day ✎
              </button>
            )}
          </div>
        </div>
        <StatCard
          label="Retention"
          value={`${Math.round(stats.retentionRate * 100)}%`}
          hint={`${stats.totalReviews} reviews`}
        />
        <StatCard
          label="Cards"
          value={stats.totalCards}
          hint={`${stats.matureCards} mastered · ${stats.newAvailable} new`}
        />
      </div>

      {/* ---- Activity heatmap ---- */}
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink-800">
            <ZapIcon className="h-4 w-4 text-ink-500" /> Activity
          </h2>
          <span className="text-2xs text-ink-500">Longest streak: {stats.longestStreak} days</span>
        </div>
        <Heatmap days={stats.heatmap} />
      </section>

      {/* ---- Calibration (predicted vs. actual) ---- */}
      {stats.calibration.sampleSize > 0 && <CalibrationCard c={stats.calibration} />}

      {/* ---- Gaps to shore up ---- */}
      {conceptGraph && conceptGraph.gaps.length > 0 && <GapsSection gaps={conceptGraph.gaps} />}

      {/* ---- Per-concept mastery ---- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-800">Mastery by concept</h2>
        {stats.concepts.length === 0 ? (
          <p className="text-sm text-ink-500">No concepts yet — generate some cards to begin.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {stats.concepts.slice(0, 30).map((c) => (
              <ConceptRow key={c.concept} concept={c} />
            ))}
          </div>
        )}
      </section>

      <div className="pb-2 text-center text-2xs text-ink-400">
        Stats as of {localDateKey(new Date())}
      </div>
    </DashboardShell>
  )
}
