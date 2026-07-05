/**
 * Flashcards — spaced-repetition cards generated from a note by Claude, reviewed
 * and edited by the user, then stored per-note in the vault's internal data dir.
 *
 * Storage: one rich-JSON deck file per source note, under the vault's internal
 * `.zennotes/flashcards/` dir (`<notePath>.cards.json`). Because it is plain
 * JSON-over-file it works on BOTH backends (Electron fs + the web HTTP bridge)
 * by reusing the generic note file primitives — the same trick the web bridge
 * uses for CSV Databases. The user-facing CSV "Databases" feature is NOT reused:
 * flat-string cells can't hold nested concepts / prerequisites / FSRS state.
 *
 * This module is PURE (no node/DOM imports) so it is shared by the main process,
 * the renderer, and the web bridge. Two shapes matter: what Claude returns (a
 * `FlashcardDraft`) versus what is stored at rest (a `Flashcard` = draft +
 * identity + an initialized, reserved `srs` block so Phase 2's FSRS scheduler
 * needs no data migration).
 */

export const FLASHCARD_STORE_VERSION = 1

/** Internal vault dir holding deck files (mirrors `.zennotes/` app-data convention). */
export const FLASHCARDS_DIR = '.zennotes/flashcards'
/** Suffix appended to a note path to form its deck file path. */
export const DECK_FILE_SUFFIX = '.cards.json'

export type FlashcardKind = 'recall' | 'synthesis'

// Recall subtypes train retrieval of material explicit in the note.
// Synthesis subtypes train transfer — connecting the note to scenarios, other
// notes, or the real world. Full definitions in the "Card taxonomy" doc.
export type RecallSubtype =
  | 'cued' // Q→A direct retrieval
  | 'reverse' // description → name the concept
  | 'cloze' // fill-in-the-blank in a sentence from the note
  | 'enumeration' // free-recall a set ("list the N …")
  | 'sequence' // order steps / "what comes after k"
  | 'causeEffect' // directional causal link
export type SynthesisSubtype =
  | 'application' // apply the concept to a new concrete scenario
  | 'connection' // link to another note / domain
  | 'contradiction' // surface and resolve an apparent tension
  | 'critique' // limits, assumptions, failure conditions
  | 'analogy' // generate an analogy for the concept
  | 'prediction' // counterfactual / forward-looking reasoning
  | 'exampleGen' // produce your own instance of the concept

export const RECALL_SUBTYPES: readonly RecallSubtype[] = [
  'cued',
  'reverse',
  'cloze',
  'enumeration',
  'sequence',
  'causeEffect'
]
export const SYNTHESIS_SUBTYPES: readonly SynthesisSubtype[] = [
  'application',
  'connection',
  'contradiction',
  'critique',
  'analogy',
  'prediction',
  'exampleGen'
]

/** The FSRS rating every review funnels to (1 | 2 | 3 | 4). */
export type FsrsRating = 'again' | 'hard' | 'good' | 'easy'

/** Numeric value of each rating on the 1–4 scale (calibration math, sorting). */
export const FSRS_RATING_VALUE: Record<FsrsRating, number> = {
  again: 1,
  hard: 2,
  good: 3,
  easy: 4
}

/** The 1–4 numeric value for an FSRS rating (NaN for an unknown/missing rating). */
export function ratingToNumber(rating: FsrsRating | undefined): number {
  return (rating && FSRS_RATING_VALUE[rating]) ?? NaN
}

/**
 * Human-readable labels for the 1–4 card-difficulty scale (the author/learner's
 * sense of how hard the card is, distinct from FSRS difficulty). Shown in the
 * review UI and summarized into the generation prompt so the numbers stay
 * calibrated to the same meanings. (There is deliberately no "trivial" level —
 * trivia isn't worth a recurring review.)
 */
export const DIFFICULTY_LABELS: Record<1 | 2 | 3 | 4, string> = {
  1: 'Easy',
  2: 'Moderate',
  3: 'Hard',
  4: 'Very hard'
}

/** Label for a difficulty value, clamped into 1–4. */
export function difficultyLabel(difficulty: number): string {
  const n = Math.min(4, Math.max(1, Math.round(difficulty))) as 1 | 2 | 3 | 4
  return DIFFICULTY_LABELS[n] ?? DIFFICULTY_LABELS[2]
}

/**
 * One-line, learner-facing explanations of each card kind and subtype. The
 * single source of truth for the review-UI info popovers (condensed from the
 * taxonomy that also drives the generation prompt), so help text and generation
 * stay in sync.
 */
export const KIND_INFO: Record<FlashcardKind, string> = {
  recall:
    'Retrieval of material explicit in the note — graded deterministically against the answer.',
  synthesis:
    'Transfer: connect the note to new scenarios, other ideas, or the real world — graded against a rubric.'
}

export const RECALL_SUBTYPE_INFO: Record<RecallSubtype, string> = {
  cued: 'Ask for a fact or definition directly ("What is X?").',
  reverse: 'Recognize the concept from its description ("Which concept is: …?").',
  cloze: 'Fill in one key term blanked out of a sentence from the note.',
  enumeration: 'Free-recall a bounded set the note states ("List the N … of X").',
  sequence: 'Order steps or events ("What step follows X?").',
  causeEffect: 'One directional causal link ("What is the effect of X?").'
}

export const SYNTHESIS_SUBTYPE_INFO: Record<SynthesisSubtype, string> = {
  application: 'Apply the concept to a new, concrete scenario not in the note.',
  connection: 'Link this concept to another note or domain.',
  contradiction: 'Resolve an apparent tension between two ideas.',
  critique: 'Probe the concept’s limits, assumptions, or failure conditions.',
  analogy: 'Generate an analogy and say where it breaks down.',
  prediction: 'Reason forward / counterfactually ("What happens if … changes? Why?").',
  exampleGen: 'Supply your own instance of the concept.'
}

// A structured rubric for grading open-ended (synthesis) answers. Generated by
// Claude, edited by the user at review, consumed by the study loop (Phase 2).
export interface RubricCriterion {
  id: string // stable uuid
  description: string // what a good answer must demonstrate (atomic)
  weight: number // relative points (1–3); used to compute a 0..1 score
}
export interface Rubric {
  criteria: RubricCriterion[] // 1–4 atomic criteria
  modelAnswer: string // an exemplar full-credit answer
  misconceptions?: string[] // common wrong turns — drive targeted feedback
}

// What Claude must return per card (validated/normalized before save).
export interface FlashcardDraft {
  kind: FlashcardKind
  subtype: RecallSubtype | SynthesisSubtype
  front: string // the prompt shown first
  back: string // recall: the answer | synthesis: a model answer
  // Grading payload — keyed by `kind` (see "Grading & rubric model"):
  acceptableAnswers?: string[] // recall ONLY: extra strings that also count as correct
  rubric?: Rubric // synthesis ONLY: REQUIRED for synthesis, absent for recall
  concepts: string[] // 1–3 labels; concepts[0] is the single FOCUS concept
  prerequisites: string[] // 1–3 concept labels needed first (free-text in P1)
  difficulty: 1 | 2 | 3 | 4 // 1 Easy · 2 Moderate · 3 Hard · 4 Very hard
  sourceQuote?: string // verbatim span from the note (for "why I got this wrong")
}

// Reserved scheduling block, initialized at save so Phase 2 (FSRS) needs no migration.
export interface SrsState {
  state: 'new' | 'learning' | 'review' | 'relearning' // 'new' in P1
  due: string | null // ISO; null until first scheduled
  stability: number | null
  difficulty: number | null // FSRS difficulty (distinct from card difficulty above)
  reps: number // 0
  lapses: number // 0
  lastReview: string | null
}

export interface Flashcard extends FlashcardDraft {
  id: string // uuid
  srs: SrsState
  userEdited: boolean // true if the user changed it during review
  createdAt: number
  generatedBy: string // model id, e.g. 'claude-sonnet-4-6'
}

export interface FlashcardDeck {
  version: typeof FLASHCARD_STORE_VERSION
  sourceNotePath: string // vault-relative POSIX path of the note
  cards: Flashcard[]
  /**
   * When a human last authored/reviewed the deck's CONTENT against the note
   * (ms). Set only by the deck review/edit save — never by grading, which also
   * rewrites this file — so `noteUpdatedAt > authoredAt` means the note moved on
   * since the cards were written. Absent on legacy decks (see `deckAuthoredAt`).
   */
  authoredAt?: number
}

/** Lightweight listing entry for deck discovery / the cross-deck index. */
export interface FlashcardDeckSummary {
  /** Vault-relative POSIX path of the source note. */
  sourceNotePath: string
  /** Vault-relative POSIX path of the deck file. */
  deckPath: string
  cardCount: number
}

// ---------------------------------------------------------------------------
// Grading & rubric records (defined now, consumed by the Phase 2 study loop).
// ---------------------------------------------------------------------------

export interface GradedCriterion {
  criterionId: string
  met: boolean
}
export interface ReviewGrade {
  cardId: string
  reviewedAt: string // ISO
  predictedRating?: FsrsRating // calibration: self-prediction BEFORE reveal (same 1–4 scale); absent when the learner skipped predicting
  rating: FsrsRating // what FSRS consumes — actual self-grade AFTER reveal
  // synthesis only — self-assessment against the bulleted rubric:
  learnerAnswer?: string
  criteria?: GradedCriterion[] // which bullets the learner checked
  score?: number // 0..1, weighted by criterion weight
}

export const REVIEW_LOG_VERSION = 1

/** Append-only per-note review history, stored beside the deck (see `logPathForNote`). */
export interface ReviewLogFile {
  version: typeof REVIEW_LOG_VERSION
  sourceNotePath: string // vault-relative POSIX path of the note
  grades: ReviewGrade[]
}

// ---------------------------------------------------------------------------
// Injectable id factory (main passes node's randomUUID; tests pass a counter).
// ---------------------------------------------------------------------------

export type GenId = () => string

export const defaultGenId: GenId = () => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `c-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

const toPosixPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '')

// ---------------------------------------------------------------------------
// Deck path helpers (deterministic, POSIX).
// ---------------------------------------------------------------------------

/** The deck file path for a note. e.g. `a/Note.md` → `.zennotes/flashcards/a/Note.md.cards.json`. */
export function deckPathForNote(notePath: string): string {
  return `${FLASHCARDS_DIR}/${toPosixPath(notePath)}${DECK_FILE_SUFFIX}`
}

/** The source note path for a deck file path, or null when it isn't a deck file. */
export function notePathFromDeckPath(deckPath: string): string | null {
  const p = toPosixPath(deckPath)
  const prefix = `${FLASHCARDS_DIR}/`
  if (!p.startsWith(prefix) || !p.endsWith(DECK_FILE_SUFFIX)) return null
  return p.slice(prefix.length, p.length - DECK_FILE_SUFFIX.length) || null
}

/** True for files that live inside the internal flashcards dir (hidden from the note list). */
export function isFlashcardInternalPath(relPath: string): boolean {
  const p = toPosixPath(relPath)
  return p === FLASHCARDS_DIR || p.startsWith(`${FLASHCARDS_DIR}/`)
}

/** The `{ from, to }` deck paths for a note rename/move (for the lifecycle hook). */
export function relocateDeckPath(
  oldNotePath: string,
  newNotePath: string
): { from: string; to: string } {
  return { from: deckPathForNote(oldNotePath), to: deckPathForNote(newNotePath) }
}

/** Suffix appended to a note path to form its review-log file path. */
export const LOG_FILE_SUFFIX = '.cards.log.json'

/** The review-log file path for a note. e.g. `a/Note.md` → `.zennotes/flashcards/a/Note.md.cards.log.json`. */
export function logPathForNote(notePath: string): string {
  return `${FLASHCARDS_DIR}/${toPosixPath(notePath)}${LOG_FILE_SUFFIX}`
}

/** True for review-log files inside the internal flashcards dir (hidden from the note list). */
export function isFlashcardLogPath(relPath: string): boolean {
  const p = toPosixPath(relPath)
  return p.startsWith(`${FLASHCARDS_DIR}/`) && p.endsWith(LOG_FILE_SUFFIX)
}

/** The `{ from, to }` review-log paths for a note rename/move (for the lifecycle hook). */
export function relocateLogPath(
  oldNotePath: string,
  newNotePath: string
): { from: string; to: string } {
  return { from: logPathForNote(oldNotePath), to: logPathForNote(newNotePath) }
}

// ---------------------------------------------------------------------------
// Virtual tab-path helpers (mirror databases.ts). A review opens as a virtual
// tab keyed by the note path, so it never hits the markdown pipeline but the
// path stays recoverable for the renderer.
// ---------------------------------------------------------------------------

const FLASHCARDS_TAB_PREFIX = 'zen://flashcards/'

export function flashcardsTabPath(notePath: string): string {
  return `${FLASHCARDS_TAB_PREFIX}${encodeURIComponent(toPosixPath(notePath))}`
}

export function isFlashcardsTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && path.startsWith(FLASHCARDS_TAB_PREFIX)
}

export function notePathFromFlashcardsTab(path: string | null | undefined): string | null {
  if (!path || !isFlashcardsTabPath(path)) return null
  const encoded = path.slice(FLASHCARDS_TAB_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Display title for a flashcards tab (the source note's basename). */
export function flashcardsTitleFromTab(path: string | null | undefined): string {
  const note = notePathFromFlashcardsTab(path)
  if (!note) return 'Flashcards'
  const base = note.split('/').filter(Boolean).pop() ?? note
  return base.replace(/\.md$/i, '')
}

// ---------------------------------------------------------------------------
// Study-session tab paths. The global review queue (`zen://study`) mirrors the
// vault-wide Tasks tab; a per-note session (`zen://study/<encoded notePath>`)
// mirrors the flashcards-review tab. Both are virtual tabs (never hit the
// markdown pipeline) rendered by EditorPane.
// ---------------------------------------------------------------------------

/** Virtual tab path for the vault-wide "study all due cards" queue. */
export const STUDY_TAB_PATH = 'zen://study'
const STUDY_TAB_PREFIX = 'zen://study/'

/** Virtual tab path for studying a single note's deck. */
export function studyTabPath(notePath: string): string {
  return `${STUDY_TAB_PREFIX}${encodeURIComponent(toPosixPath(notePath))}`
}

/** True for both the global study tab and any per-note study tab. */
export function isStudyTabPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && (path === STUDY_TAB_PATH || path.startsWith(STUDY_TAB_PREFIX))
}

/** The source note path for a per-note study tab, or null for the global queue. */
export function notePathFromStudyTab(path: string | null | undefined): string | null {
  if (!path || !path.startsWith(STUDY_TAB_PREFIX)) return null
  const encoded = path.slice(STUDY_TAB_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Display title for a study tab (note basename, or "Study" for the global queue). */
export function studyTitleFromTab(path: string | null | undefined): string {
  const note = notePathFromStudyTab(path)
  if (!note) return 'Study'
  const base = note.split('/').filter(Boolean).pop() ?? note
  return `Study · ${base.replace(/\.md$/i, '')}`
}

// ---------------------------------------------------------------------------
// Study dashboard tab. A single vault-wide virtual tab (like the global study
// queue and the Tasks tab) that renders the gamified study hub: streak,
// daily-goal ring, activity heatmap, per-concept mastery, and start-studying
// entry points.
// ---------------------------------------------------------------------------

/** Virtual tab path for the vault-wide study dashboard. */
export const STUDY_DASHBOARD_TAB_PATH = 'zen://dashboard'

/** True for the study dashboard tab. */
export function isStudyDashboardTabPath(path: string | null | undefined): boolean {
  return path === STUDY_DASHBOARD_TAB_PATH
}

/** Virtual tab path for the vault-wide concept (knowledge) graph. */
export const CONCEPT_GRAPH_TAB_PATH = 'zen://concept-graph'

/** True for the concept-graph tab. */
export function isConceptGraphTabPath(path: string | null | undefined): boolean {
  return path === CONCEPT_GRAPH_TAB_PATH
}

// TEMP(feedback-lab): scratch tab for auditioning grade-feedback patterns. Remove
// this block and its references (FeedbackLab.tsx, workspace-tabs, commands, EditorPane).
/** Virtual tab path for the temporary grade-feedback playground. */
export const FEEDBACK_LAB_TAB_PATH = 'zen://feedback-lab'

/** True for the feedback-lab tab. */
export function isFeedbackLabTabPath(path: string | null | undefined): boolean {
  return path === FEEDBACK_LAB_TAB_PATH
}

// ---------------------------------------------------------------------------
// Defensive normalization of Claude output (mirror dbNormalizeSidecar).
// ---------------------------------------------------------------------------

const asString = (v: unknown): string => (typeof v === 'string' ? v : '')
const trimmed = (v: unknown): string => asString(v).trim()

/** Clamp a free-text label list to 1–3 non-empty, deduped, trimmed entries. */
function clampLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const s = trimmed(item)
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= 3) break
  }
  return out
}

/** Normalize an answer-string list: trim, drop empties, dedupe. */
function normalizeAnswers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    const s = trimmed(item)
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

function clampDifficulty(raw: unknown): 1 | 2 | 3 | 4 {
  const n = Math.round(Number(raw))
  if (!Number.isFinite(n)) return 2 // default: Moderate
  return Math.min(4, Math.max(1, n)) as 1 | 2 | 3 | 4
}

/** Validate + normalize a rubric; returns null when it can't satisfy the contract. */
function normalizeRubric(raw: unknown, genId: GenId): Rubric | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const modelAnswer = trimmed(r.modelAnswer)
  if (!modelAnswer) return null
  const rawCriteria = Array.isArray(r.criteria) ? r.criteria : []
  const criteria: RubricCriterion[] = []
  for (const c of rawCriteria) {
    if (!c || typeof c !== 'object') continue
    const cc = c as Record<string, unknown>
    const description = trimmed(cc.description)
    const weight = Number(cc.weight)
    if (!description || !Number.isFinite(weight) || weight <= 0) continue
    criteria.push({
      id: trimmed(cc.id) || genId(),
      description,
      weight: Math.min(3, Math.max(1, Math.round(weight)))
    })
    if (criteria.length >= 4) break
  }
  if (criteria.length === 0) return null
  const misconceptions = normalizeAnswers(r.misconceptions)
  const rubric: Rubric = { criteria, modelAnswer }
  if (misconceptions.length) rubric.misconceptions = misconceptions
  return rubric
}

/**
 * Defensive parse of one Claude card object. Enforces the atomicity + grading
 * contract: a valid `subtype` for its `kind`, non-empty front/back, 1–3
 * concepts/prerequisites, clamped difficulty, a valid `Rubric` on synthesis
 * cards (and NO rubric on recall cards). Returns null to DROP an invalid card.
 */
export function normalizeDraft(raw: unknown, genId: GenId = defaultGenId): FlashcardDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const kind = o.kind === 'synthesis' ? 'synthesis' : o.kind === 'recall' ? 'recall' : null
  if (!kind) return null

  const subtype = trimmed(o.subtype)
  const validSubtype =
    kind === 'recall'
      ? (RECALL_SUBTYPES as readonly string[]).includes(subtype)
      : (SYNTHESIS_SUBTYPES as readonly string[]).includes(subtype)
  if (!validSubtype) return null

  const front = trimmed(o.front)
  const back = trimmed(o.back)
  if (!front || !back) return null

  const concepts = clampLabels(o.concepts)
  if (concepts.length === 0) return null
  const prerequisites = clampLabels(o.prerequisites)

  const draft: FlashcardDraft = {
    kind,
    subtype: subtype as RecallSubtype | SynthesisSubtype,
    front,
    back,
    concepts,
    prerequisites,
    difficulty: clampDifficulty(o.difficulty)
  }

  const sourceQuote = trimmed(o.sourceQuote)
  if (sourceQuote) draft.sourceQuote = sourceQuote

  if (kind === 'synthesis') {
    const rubric = normalizeRubric(o.rubric, genId)
    if (!rubric) return null // synthesis MUST carry a valid rubric
    draft.rubric = rubric
  } else {
    // Recall cards must NOT carry a rubric; acceptableAnswers is optional.
    const acceptable = normalizeAnswers(o.acceptableAnswers)
    if (acceptable.length) draft.acceptableAnswers = acceptable
  }

  return draft
}

/** A fresh, unscheduled `SrsState` (`state:'new'`) — initialized at save time. */
export function newSrsState(): SrsState {
  return {
    state: 'new',
    due: null,
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    lastReview: null
  }
}

/** Promote a reviewed draft to a stored card with identity + initialized srs. */
export function draftToCard(
  draft: FlashcardDraft,
  model: string,
  opts: { userEdited?: boolean; genId?: GenId; now?: number } = {}
): Flashcard {
  const genId = opts.genId ?? defaultGenId
  return {
    ...draft,
    id: genId(),
    srs: newSrsState(),
    userEdited: opts.userEdited ?? false,
    createdAt: opts.now ?? Date.now(),
    generatedBy: model
  }
}

export function emptyDeck(notePath: string): FlashcardDeck {
  return { version: FLASHCARD_STORE_VERSION, sourceNotePath: toPosixPath(notePath), cards: [] }
}

/**
 * When the deck's content was last authored: the explicit `authoredAt`, or —
 * for legacy decks predating the field — the newest card's `createdAt` (edits
 * preserve card identity, so appended cards are the only fallback signal).
 */
export function deckAuthoredAt(deck: FlashcardDeck): number {
  if (deck.authoredAt != null && Number.isFinite(deck.authoredAt)) return deck.authoredAt
  let latest = 0
  for (const card of deck.cards) {
    if (Number.isFinite(card.createdAt) && card.createdAt > latest) latest = card.createdAt
  }
  return latest
}

/** True when the source note was edited after the deck's content was last authored. */
export function isDeckStale(deck: FlashcardDeck, noteUpdatedAt: number): boolean {
  return Number.isFinite(noteUpdatedAt) && noteUpdatedAt > deckAuthoredAt(deck)
}

/** A fresh, empty review-log file for a note. */
export function emptyReviewLog(notePath: string): ReviewLogFile {
  return { version: REVIEW_LOG_VERSION, sourceNotePath: toPosixPath(notePath), grades: [] }
}

/** Append a grade to a (possibly null) review log, returning a new log file. */
export function appendReviewGrade(
  log: ReviewLogFile | null,
  notePath: string,
  grade: ReviewGrade
): ReviewLogFile {
  const base = log ?? emptyReviewLog(notePath)
  return { ...base, grades: [...base.grades, grade] }
}

/** True when an ISO timestamp falls on the same local calendar day as `now`. */
function isSameLocalDay(iso: string, now: Date): boolean {
  const t = new Date(iso)
  return (
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate()
  )
}

/** Count grades whose `reviewedAt` falls on the same local calendar day as `now`. */
export function countReviewsOnDay(grades: ReviewGrade[], now: Date = new Date()): number {
  let count = 0
  for (const g of grades) if (isSameLocalDay(g.reviewedAt, now)) count++
  return count
}

/**
 * Daily-limit accounting from review logs: how many NEW cards were introduced
 * today (a card whose earliest-ever grade is today) vs. how many other reviews
 * happened today. Drives the per-day new/review caps in the study queue.
 */
export function countDailyProgress(
  logs: ReviewLogFile[],
  now: Date = new Date()
): { newDoneToday: number; reviewsDoneToday: number } {
  const earliestByCard = new Map<string, number>()
  let totalToday = 0
  for (const log of logs) {
    for (const g of log.grades) {
      const t = Date.parse(g.reviewedAt)
      const prev = earliestByCard.get(g.cardId)
      if (prev == null || (Number.isFinite(t) && t < prev)) earliestByCard.set(g.cardId, t)
      if (isSameLocalDay(g.reviewedAt, now)) totalToday++
    }
  }
  let newDoneToday = 0
  for (const earliest of earliestByCard.values()) {
    if (Number.isFinite(earliest) && isSameLocalDay(new Date(earliest).toISOString(), now)) {
      newDoneToday++
    }
  }
  return { newDoneToday, reviewsDoneToday: Math.max(0, totalToday - newDoneToday) }
}

/** Cross-deck index: cardId → its card + the note it came from (used in Phase 2). */
export function buildCardIndex(
  decks: FlashcardDeck[]
): Record<string, { card: Flashcard; sourceNotePath: string }> {
  const index: Record<string, { card: Flashcard; sourceNotePath: string }> = {}
  for (const deck of decks) {
    for (const card of deck.cards) {
      index[card.id] = { card, sourceNotePath: deck.sourceNotePath }
    }
  }
  return index
}

// ---------------------------------------------------------------------------
// Grading helpers (pure; ship now, used by the Phase 2 study loop).
// ---------------------------------------------------------------------------

/** Weighted fraction of rubric criteria the learner met → a 0..1 score. */
export function scoreRubric(rubric: Rubric, criteria: GradedCriterion[]): number {
  const total = rubric.criteria.reduce((sum, c) => sum + c.weight, 0)
  if (total <= 0) return 0
  const metById = new Map(criteria.map((c) => [c.criterionId, c.met]))
  const earned = rubric.criteria.reduce(
    (sum, c) => sum + (metById.get(c.id) ? c.weight : 0),
    0
  )
  return earned / total
}

/** Map a 0..1 rubric score to a suggested FSRS rating (pure threshold). */
export function scoreToRating(score: number): FsrsRating {
  if (score < 0.25) return 'again'
  if (score < 0.6) return 'hard'
  if (score < 0.9) return 'good'
  return 'easy'
}

/**
 * Locate a card's `sourceQuote` within its note body, returning the character
 * offset of the matched block (or null when it can't be found — e.g. the note
 * was edited after generation). Tries an exact match first, then a
 * whitespace-flexible match so a quote captured with collapsed spaces/newlines
 * still resolves. Used to jump from a card directly to its source block.
 */
export function findSourceQuoteOffset(body: string, quote: string): number | null {
  const q = quote.trim()
  if (!q || !body) return null
  const exact = body.indexOf(q)
  if (exact >= 0) return exact
  // Whitespace-flexible fallback: collapse internal whitespace to `\s+`.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  try {
    const match = new RegExp(escaped).exec(body)
    return match ? match.index : null
  } catch {
    return null
  }
}

const normalizeAnswerText = (s: string): string =>
  s.trim().toLowerCase().replace(/\s+/g, ' ')

/** How a typed recall answer compares to the card's answer(s). */
export type RecallMatch = 'exact' | 'close' | 'miss'

/** Damerau–Levenshtein (OSA) edit distance — insertions, deletions,
 *  substitutions, and adjacent transpositions each cost 1, since swapped
 *  letters are the most common honest typo. Iterative rows; pure, zero-dep. */
function editDistance(a: string, b: string): number {
  const cols = b.length + 1
  let prev2: number[] = []
  let prev: number[] = []
  for (let j = 0; j < cols; j++) prev.push(j)
  for (let i = 1; i <= a.length; i++) {
    const curr: number[] = [i]
    for (let j = 1; j < cols; j++) {
      let d = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, prev2[j - 2] + 1)
      }
      curr.push(d)
    }
    prev2 = prev
    prev = curr
  }
  return prev[cols - 1]
}

/** Edit-distance budget for a "close" match against a candidate of this length. */
function closeEditBudget(len: number): number {
  return Math.min(4, Math.max(1, Math.floor(len * 0.15)))
}

/**
 * Tiered auto-check for a typed recall answer against back + acceptableAnswers.
 * `exact` is normalized equality (the only tier the strict boolean check ever
 * granted); `close` tolerates honest typos — a length-scaled edit distance, or,
 * for multi-word answers, all answer words present in what was typed — so typing
 * an answer isn't punished by exact-string matching. Candidates of ≤2 characters
 * must match exactly (too short to fuzz).
 */
export function matchRecallAnswer(
  typed: string,
  back: string,
  acceptableAnswers: string[] = []
): RecallMatch {
  const t = normalizeAnswerText(typed)
  if (!t) return 'miss'
  const candidates = [back, ...acceptableAnswers].map(normalizeAnswerText).filter(Boolean)
  if (candidates.includes(t)) return 'exact'
  const typedTokens = new Set(t.split(' '))
  for (const cand of candidates) {
    if (cand.length <= 2) continue
    const budget = closeEditBudget(cand.length)
    // Length gap is a lower bound on edit distance — skip the O(n·m) walk early.
    if (Math.abs(cand.length - t.length) <= budget && editDistance(t, cand) <= budget) {
      return 'close'
    }
    const candTokens = cand.split(' ')
    if (candTokens.length >= 2 && candTokens.every((tok) => typedTokens.has(tok))) return 'close'
  }
  return 'miss'
}

/** Suggested FSRS rating for a typed recall answer (never `easy` — that stays a
 *  deliberate choice about future scheduling, not something to auto-suggest). */
export function recallMatchToRating(match: RecallMatch): FsrsRating {
  return match === 'exact' ? 'good' : match === 'close' ? 'hard' : 'again'
}

/** Auto-check assist for recall cards: typed answer vs. back + acceptableAnswers. */
export function checkRecallAnswer(
  typed: string,
  back: string,
  acceptableAnswers: string[] = []
): boolean {
  return matchRecallAnswer(typed, back, acceptableAnswers) === 'exact'
}
