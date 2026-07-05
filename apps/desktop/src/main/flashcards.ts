/**
 * Main-process IO + Claude integration for flashcards. Decks are rich-JSON
 * files under the vault's internal `.zennotes/flashcards/` dir, one per source
 * note. The pure model/normalization logic lives in `@shared/flashcards`; this
 * module bridges it to disk and to the Anthropic SDK.
 *
 * Generation is desktop-only in Phase 1 (the web bridge throws a clear
 * "desktop only" error). The API key is read from the OS secret store; the
 * default model is `claude-sonnet-4-6` (a user-locked decision), overridable in
 * Settings.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import {
  appendReviewGrade as appendReviewGradePure,
  deckPathForNote,
  emptyDeck,
  logPathForNote,
  normalizeDraft,
  notePathFromDeckPath,
  relocateDeckPath,
  relocateLogPath,
  FLASHCARDS_DIR,
  FLASHCARD_STORE_VERSION,
  type FlashcardDeck,
  type FlashcardDeckSummary,
  type FlashcardDraft,
  type ReviewGrade,
  type ReviewLogFile
} from '@shared/flashcards'
import {
  DEFAULT_STUDY_GAMIFICATION,
  normalizeGamification,
  type StudyGamification
} from '@shared/study-stats'
import type { FlashcardDensity } from '@shared/ipc'
import { DEFAULT_FLASHCARD_DENSITY } from '@shared/ipc'
import type { FlashcardCardMix } from '@zennotes/bridge-contract/bridge'
import { absolutePath, writeFileAtomic } from './vault'
import { getAnthropicApiKey } from './secret-store'

export const DEFAULT_FLASHCARD_MODEL = 'claude-sonnet-4-6'
/** Models offered in Settings (default first). */
export const FLASHCARD_MODELS = [
  DEFAULT_FLASHCARD_MODEL,
  'claude-haiku-4-5',
  'claude-opus-4-8'
] as const

/**
 * Hard ceiling on cards per generation run. Keeps a long note from producing a
 * giant review batch (and a giant future-review obligation); the UI offers
 * "Generate more" as a deliberate second action instead.
 */
export const FLASHCARD_MAX_PER_RUN = 20

/** Per-density steer injected into the generation prompt. */
const DENSITY_GUIDANCE: Record<FlashcardDensity, string> = {
  concise:
    'DENSITY: concise. Test ONLY the most essential, load-bearing concepts. A handful of high-value cards is the goal — skip secondary detail.',
  balanced:
    'DENSITY: balanced. Cover each key concept once, with a synthesis card wherever the concept supports meaningful transfer.',
  thorough:
    'DENSITY: thorough. Cover every distinct concept in the note, pairing recall with synthesis to push transfer — but still no padding.'
}

/** Typed error the renderer maps to a "Set your key in Settings" prompt. */
export class MissingAnthropicKeyError extends Error {
  readonly code = 'NO_ANTHROPIC_KEY'
  constructor() {
    super('No Anthropic API key is set. Add one in Settings to generate flashcards.')
    this.name = 'MissingAnthropicKeyError'
  }
}

// ---------------------------------------------------------------------------
// Deck file IO
// ---------------------------------------------------------------------------

/** Read the saved deck for a note, or null when none exists. */
export async function readFlashcards(root: string, notePath: string): Promise<FlashcardDeck | null> {
  const abs = absolutePath(root, deckPathForNote(notePath))
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as FlashcardDeck
    if (!parsed || !Array.isArray(parsed.cards)) return null
    return parsed
  } catch {
    // A corrupt deck file shouldn't crash the app; treat as absent.
    return null
  }
}

/** Persist a deck for a note (creating `.zennotes/flashcards/…` as needed). */
export async function writeFlashcards(
  root: string,
  notePath: string,
  deck: FlashcardDeck
): Promise<FlashcardDeck> {
  const normalized: FlashcardDeck = {
    version: FLASHCARD_STORE_VERSION,
    sourceNotePath: notePath.replace(/\\/g, '/').replace(/^\/+/, ''),
    cards: deck.cards ?? [],
    // Preserve the content-authored timestamp; every other write (e.g. grading)
    // must not lose it, or deck staleness detection silently breaks.
    ...(deck.authoredAt != null ? { authoredAt: deck.authoredAt } : {})
  }
  const abs = absolutePath(root, deckPathForNote(notePath))
  await writeFileAtomic(abs, JSON.stringify(normalized, null, 2))
  return normalized
}

/** Enumerate every deck (source note + card count) for the cross-deck index. */
export async function listFlashcardDecks(root: string): Promise<FlashcardDeckSummary[]> {
  const baseAbs = absolutePath(root, FLASHCARDS_DIR)
  const out: FlashcardDeckSummary[] = []

  async function walk(dirAbs: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name)
      if (entry.isDirectory()) {
        await walk(childAbs)
        continue
      }
      if (!entry.name.endsWith('.cards.json')) continue
      const rel = path.relative(absolutePath(root, '.'), childAbs).replace(/\\/g, '/')
      const sourceNotePath = notePathFromDeckPath(rel)
      if (!sourceNotePath) continue
      let cardCount = 0
      try {
        const parsed = JSON.parse(await fs.readFile(childAbs, 'utf8')) as FlashcardDeck
        cardCount = Array.isArray(parsed?.cards) ? parsed.cards.length : 0
      } catch {
        continue
      }
      out.push({ sourceNotePath, deckPath: rel, cardCount })
    }
  }

  await walk(baseAbs)
  return out
}

// ---------------------------------------------------------------------------
// Study gamification config IO (single vault-wide file beside the decks).
// ---------------------------------------------------------------------------

/** Vault-relative path of the persisted gamification config. */
const GAMIFICATION_FILE = `${FLASHCARDS_DIR}/gamification.json`

/** Read the study gamification config, falling back to defaults when absent/corrupt. */
export async function readStudyGamification(root: string): Promise<StudyGamification> {
  const abs = absolutePath(root, GAMIFICATION_FILE)
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_STUDY_GAMIFICATION }
    throw err
  }
  try {
    return normalizeGamification(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_STUDY_GAMIFICATION }
  }
}

/** Persist the study gamification config (normalized first), returning the stored value. */
export async function writeStudyGamification(
  root: string,
  gam: StudyGamification
): Promise<StudyGamification> {
  const normalized = normalizeGamification(gam)
  const abs = absolutePath(root, GAMIFICATION_FILE)
  await writeFileAtomic(abs, JSON.stringify(normalized, null, 2))
  return normalized
}

/** Read the append-only review log for a note, or null when none exists. */
export async function readReviewLog(root: string, notePath: string): Promise<ReviewLogFile | null> {
  const abs = absolutePath(root, logPathForNote(notePath))
  let raw: string
  try {
    raw = await fs.readFile(abs, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as ReviewLogFile
    if (!parsed || !Array.isArray(parsed.grades)) return null
    return parsed
  } catch {
    return null // corrupt log shouldn't crash the app; treat as absent
  }
}

/** Append one grade to a note's review log (creating the file as needed). */
export async function appendReviewGrade(
  root: string,
  notePath: string,
  grade: ReviewGrade
): Promise<ReviewLogFile> {
  const existing = await readReviewLog(root, notePath)
  const next = appendReviewGradePure(existing, notePath, grade)
  const abs = absolutePath(root, logPathForNote(notePath))
  await writeFileAtomic(abs, JSON.stringify(next, null, 2))
  return next
}

/** Move a file when its note moves (rewriting nothing). No-op when absent. */
async function relocateFile(root: string, from: string, to: string): Promise<void> {
  const fromAbs = absolutePath(root, from)
  try {
    await fs.access(fromAbs)
  } catch {
    return
  }
  const toAbs = absolutePath(root, to)
  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
}

/**
 * Move a note's deck AND review-log files when the note is renamed/moved/trashed
 * (and rewrite the deck's `sourceNotePath`). No-op for files that don't exist.
 * Used by the vault rename/move/trash handlers so decks never orphan.
 */
export async function relocateFlashcards(
  root: string,
  oldNotePath: string,
  newNotePath: string
): Promise<void> {
  if (oldNotePath === newNotePath) return
  const { from, to } = relocateDeckPath(oldNotePath, newNotePath)
  const fromAbs = absolutePath(root, from)
  const toAbs = absolutePath(root, to)
  try {
    await fs.access(fromAbs)
    const deck = await readFlashcards(root, oldNotePath)
    await fs.mkdir(path.dirname(toAbs), { recursive: true })
    await fs.rename(fromAbs, toAbs)
    if (deck) {
      // Rewrite the recorded source path so the deck stays self-describing.
      await writeFlashcards(root, newNotePath, { ...deck, sourceNotePath: newNotePath })
    }
  } catch {
    // no deck to move
  }
  // Carry the review log alongside the deck (no content rewrite needed).
  const log = relocateLogPath(oldNotePath, newNotePath)
  await relocateFile(root, log.from, log.to)
}

/** Delete a note's deck + review-log files (on permanent delete). No-op when absent. */
export async function deleteFlashcards(root: string, notePath: string): Promise<void> {
  for (const rel of [deckPathForNote(notePath), logPathForNote(notePath)]) {
    try {
      await fs.unlink(absolutePath(root, rel))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Claude generation
// ---------------------------------------------------------------------------

/**
 * The generation system prompt. Exported so it can be iterated and unit-checked.
 * Condenses the card taxonomy (the source of truth) into instructions and pins
 * the atomicity + grading contract enforced by `normalizeDraft`.
 */
export const FLASHCARD_SYSTEM_PROMPT = `You are an expert learning-science tutor that turns a single note into spaced-repetition flashcards.

Return ONLY a raw JSON array of card objects — no prose, no markdown fences, no preamble. Each object has this exact shape:

{
  "kind": "recall" | "synthesis",
  "subtype": <one subtype string valid for the kind, see taxonomy>,
  "front": <string, the prompt shown first>,
  "back": <string, recall: the answer; synthesis: a model answer>,
  "concepts": [<1-3 short labels; concepts[0] is THE single focus concept>],
  "prerequisites": [<0-3 short concept labels needed first>],
  "difficulty": <integer 1-4: 1 Easy, 2 Moderate, 3 Hard, 4 Very hard>,
  "sourceQuote": <optional verbatim span copied from the note>,
  "acceptableAnswers": [<recall ONLY, optional: extra strings that also count as correct>],
  "rubric": {                       // synthesis ONLY — REQUIRED for synthesis, OMIT for recall
    "criteria": [{ "description": <atomic thing a good answer must show>, "weight": <1-3> }],  // 1-4 criteria
    "modelAnswer": <string, a full-credit exemplar>,
    "misconceptions": [<optional common wrong turns>]
  }
}

ATOMICITY: every card tests ONE focus concept and ONE thing, gradeable in isolation. Keep concepts <= 3 and prerequisites <= 3, all as short labels. Put complexity in the prerequisite/concept graph, not in fat cards.

HOW MANY CARDS: the count follows the note's distinct atomic CONCEPTS, never its length. First identify the key concepts worth remembering, then make roughly one recall card per concept plus a synthesis card only where transfer genuinely matters. Every card is a recurring review obligation, so be selective: skip trivia and restating, and do NOT pad to reach a number. Fewer high-value cards beat exhaustive coverage. A short dense note may warrant many cards; a long shallow one, few.

RECALL kinds test material EXPLICIT in the note, graded deterministically. Subtypes:
- cued: a fact/definition directly ("What is {concept}?"). Default for atomic facts; reach for a sharper subtype when one fits.
- reverse: recognize a concept from its description ("Which concept is described by: '{definition}'?").
- cloze: one key term blanked in a sentence from the note.
- enumeration: free-recall a bounded set the note states ("List the N ... of {concept}."). Back lists the full set.
- sequence: order of steps/events ("What step immediately follows '{step}'?").
- causeEffect: one directional causal link ("What is the effect of {cause}?").

SYNTHESIS kinds connect the note to scenarios, other notes, or the real world. Open-ended; graded against the rubric. A synthesis card must demand genuine TRANSFER — never a restatement of the note. Force the learner to do real work: apply the idea to a NOVEL scenario, weigh trade-offs, expose hidden assumptions / failure modes / edge cases, or explain WHY rather than WHAT. Aim for expert-level depth — these are the hard, high-value cards. Subtypes:
- application: apply the concept to a NEW concrete scenario (not from the note).
- connection: link this concept to another note/domain.
- contradiction: resolve an apparent tension between two ideas.
- critique: the concept's limits, assumptions, failure conditions.
- analogy: generate an analogy and say where it breaks.
- prediction: a counterfactual / forward inference ("What happens to {system} if {variable} changes? Why?").
- exampleGen: the learner supplies their own instance of the concept.

DIFFICULTY: bias hard on purpose. Most cards should be 2-4 (Moderate to Very hard), and synthesis cards typically 3-4. Do NOT produce easy restating or vocabulary-drill cards — if a card would be trivial, either sharpen it into a real challenge or drop it.

MIX: synthesis is the main event. Default to roughly 70% synthesis / 30% recall — emit recall cards only for the essential facts a learner must hold in memory before they can reason. (A note may justify a different split, but lean synthesis unless told otherwise.)

CONTRACT (cards violating it are dropped): a subtype must match its kind; recall cards have a concrete back and NO rubric; every synthesis card MUST carry a valid rubric (>=1 criterion with non-empty description + positive weight, plus a non-empty modelAnswer). Favor a SPREAD of subtypes over a pile of cued cards — variety is a desirable difficulty.`

const CARD_MIX_GUIDANCE: Record<FlashcardCardMix, string> = {
  balanced:
    'MIX: lean synthesis — roughly 70% synthesis / 30% recall. Synthesis is the main event; include recall cards only for the essential facts a learner must hold before they can reason.',
  recall:
    'MIX: favor recall cards (direct retrieval of material in the note); include a synthesis card only where transfer is clearly valuable.',
  synthesis:
    'MIX: almost entirely synthesis cards (application, connection, critique, etc.); include recall cards only for the few facts strictly required to attempt them.'
}

/** How many related notes to include, and how much of each, for cross-note synthesis. */
const MAX_RELATED_NOTES = 5
const MAX_RELATED_NOTE_CHARS = 8000

interface RelatedNote {
  notePath: string
  body: string
}

interface UserPromptParams {
  notePath: string
  body: string
  density: FlashcardDensity
  existing: string[]
  cardMix: FlashcardCardMix
  maxCards: number
  instructions: string
  guidance: string
  relatedNotes: RelatedNote[]
}

function buildUserPrompt(p: UserPromptParams): string {
  const directives = [
    DENSITY_GUIDANCE[p.density] ?? DENSITY_GUIDANCE[DEFAULT_FLASHCARD_DENSITY],
    CARD_MIX_GUIDANCE[p.cardMix] ?? CARD_MIX_GUIDANCE.balanced,
    `Produce AT MOST ${p.maxCards} cards this run.`
  ]
  if (p.relatedNotes.length > 0) {
    directives.push(
      `CROSS-NOTE SYNTHESIS: in addition to cards about the primary note, generate synthesis cards that connect the primary note's concepts to the RELATED NOTES below. Each cross-note card's "concepts" should span both notes, and its "prerequisites" should name the connected concept(s). Only make such a card where a genuine, non-obvious connection exists — never force one.`
    )
  }
  if (p.guidance.trim()) {
    directives.push(
      `STANDING GUIDANCE (the learner's persistent preferences — honor unless a per-run instruction overrides, and never break the JSON shape or the card contract):\n${p.guidance.trim()}`
    )
  }
  if (p.existing.length > 0) {
    const list = p.existing.slice(0, 60).map((s) => `- ${s}`).join('\n')
    directives.push(
      `These cards/concepts already exist for this note — do NOT repeat them; produce different, complementary cards (return an empty array if nothing worthwhile remains):\n${list}`
    )
  }
  if (p.instructions.trim()) {
    directives.push(
      `ADDITIONAL INSTRUCTIONS FOR THIS RUN (these take precedence over the standing guidance, but never break the JSON shape or the card contract):\n${p.instructions.trim()}`
    )
  }
  const related =
    p.relatedNotes.length > 0
      ? '\n\n' +
        p.relatedNotes
          .map((r) => `--- RELATED NOTE (${r.notePath}) ---\n${r.body}\n--- END RELATED NOTE ---`)
          .join('\n\n')
      : ''
  return `Generate study cards from the note below (vault path: ${p.notePath}).\n\n${directives.join(
    '\n'
  )}\n\n--- NOTE START ---\n${p.body}\n--- NOTE END ---${related}\n\nReturn the JSON array now.`
}

/** Extract the JSON array from a model response, tolerating stray prose/fences. */
function extractJsonArray(text: string): unknown[] {
  const trimmed = text.trim()
  // Strip a leading ```json fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export interface GenerateFlashcardsResult {
  drafts: FlashcardDraft[]
  dropped: number
}

/**
 * Load a note, prompt Claude, and return validated draft cards plus the count
 * of cards that failed normalization. Rejects with MissingAnthropicKeyError
 * when no key is stored.
 */
export async function generateFlashcards(
  root: string,
  notePath: string,
  opts: {
    model?: string
    density?: FlashcardDensity
    existing?: string[]
    cardMix?: FlashcardCardMix
    maxCards?: number
    instructions?: string
    guidance?: string
    relatedNotePaths?: string[]
  } = {}
): Promise<GenerateFlashcardsResult> {
  const apiKey = await getAnthropicApiKey()
  if (!apiKey) throw new MissingAnthropicKeyError()

  const body = await fs.readFile(absolutePath(root, notePath), 'utf8')

  // Cross-note synthesis: pull a few related notes as extra context (best-effort).
  const relatedPaths = (opts.relatedNotePaths ?? [])
    .filter((p) => typeof p === 'string' && p.trim() && p !== notePath)
    .slice(0, MAX_RELATED_NOTES)
  const relatedNotes: RelatedNote[] = []
  for (const rp of relatedPaths) {
    try {
      const rb = await fs.readFile(absolutePath(root, rp), 'utf8')
      relatedNotes.push({ notePath: rp, body: rb.slice(0, MAX_RELATED_NOTE_CHARS) })
    } catch {
      // a missing/unreadable related note is simply skipped
    }
  }
  const model = opts.model?.trim() || DEFAULT_FLASHCARD_MODEL
  const density = opts.density ?? DEFAULT_FLASHCARD_DENSITY
  const existing = (opts.existing ?? []).filter((s) => typeof s === 'string' && s.trim())
  const cardMix: FlashcardCardMix = opts.cardMix ?? 'balanced'
  // Clamp a requested target into [1, hard cap]; default to the hard cap.
  const maxCards = Number.isFinite(opts.maxCards)
    ? Math.min(FLASHCARD_MAX_PER_RUN, Math.max(1, Math.round(opts.maxCards as number)))
    : FLASHCARD_MAX_PER_RUN

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: FLASHCARD_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({
          notePath,
          body,
          density,
          existing,
          cardMix,
          maxCards,
          instructions: opts.instructions ?? '',
          guidance: opts.guidance ?? '',
          relatedNotes
        })
      }
    ]
  })

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  const rawCards = extractJsonArray(text)
  const drafts: FlashcardDraft[] = []
  let dropped = 0
  for (const raw of rawCards) {
    const draft = normalizeDraft(raw, randomUUID)
    if (draft) drafts.push(draft)
    else dropped++
  }
  // Defensive cap — the prompt asks for at most N, but enforce it regardless.
  if (drafts.length > maxCards) {
    drafts.length = maxCards
  }
  return { drafts, dropped }
}

/** Convenience used by tests/manual flows: a fresh empty deck for a note. */
export { emptyDeck }
