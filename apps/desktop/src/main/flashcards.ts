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
  deckPathForNote,
  emptyDeck,
  normalizeDraft,
  notePathFromDeckPath,
  relocateDeckPath,
  FLASHCARDS_DIR,
  FLASHCARD_STORE_VERSION,
  type FlashcardDeck,
  type FlashcardDeckSummary,
  type FlashcardDraft
} from '@shared/flashcards'
import { absolutePath, writeFileAtomic } from './vault'
import { getAnthropicApiKey } from './secret-store'

export const DEFAULT_FLASHCARD_MODEL = 'claude-sonnet-4-6'
/** Models offered in Settings (default first). */
export const FLASHCARD_MODELS = [
  DEFAULT_FLASHCARD_MODEL,
  'claude-haiku-4-5',
  'claude-opus-4-8'
] as const

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
    cards: deck.cards ?? []
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

/**
 * Move a note's deck file when the note is renamed/moved/trashed (and rewrite
 * its `sourceNotePath`). No-op when the note has no deck. Used by the vault
 * rename/move/trash handlers so decks never orphan.
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
  } catch {
    return // no deck to move
  }
  const deck = await readFlashcards(root, oldNotePath)
  await fs.mkdir(path.dirname(toAbs), { recursive: true })
  await fs.rename(fromAbs, toAbs)
  if (deck) {
    // Rewrite the recorded source path so the deck stays self-describing.
    await writeFlashcards(root, newNotePath, { ...deck, sourceNotePath: newNotePath })
  }
}

/** Delete a note's deck file (on permanent delete). No-op when absent. */
export async function deleteFlashcards(root: string, notePath: string): Promise<void> {
  const abs = absolutePath(root, deckPathForNote(notePath))
  try {
    await fs.unlink(abs)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
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
  "difficulty": <integer 1-5: 1 Trivial, 2 Easy, 3 Moderate, 4 Hard, 5 Very hard>,
  "sourceQuote": <optional verbatim span copied from the note>,
  "acceptableAnswers": [<recall ONLY, optional: extra strings that also count as correct>],
  "rubric": {                       // synthesis ONLY — REQUIRED for synthesis, OMIT for recall
    "criteria": [{ "description": <atomic thing a good answer must show>, "weight": <1-3> }],  // 1-4 criteria
    "modelAnswer": <string, a full-credit exemplar>,
    "misconceptions": [<optional common wrong turns>]
  }
}

ATOMICITY: every card tests ONE focus concept and ONE thing, gradeable in isolation. Keep concepts <= 3 and prerequisites <= 3, all as short labels. Put complexity in the prerequisite/concept graph, not in fat cards.

RECALL kinds test material EXPLICIT in the note, graded deterministically. Subtypes:
- cued: a fact/definition directly ("What is {concept}?"). Default for atomic facts; reach for a sharper subtype when one fits.
- reverse: recognize a concept from its description ("Which concept is described by: '{definition}'?").
- cloze: one key term blanked in a sentence from the note.
- enumeration: free-recall a bounded set the note states ("List the N ... of {concept}."). Back lists the full set.
- sequence: order of steps/events ("What step immediately follows '{step}'?").
- causeEffect: one directional causal link ("What is the effect of {cause}?").

SYNTHESIS kinds connect the note to scenarios, other notes, or the real world. Open-ended; graded against the rubric. Subtypes:
- application: apply the concept to a NEW concrete scenario (not from the note).
- connection: link this concept to another note/domain.
- contradiction: resolve an apparent tension between two ideas.
- critique: the concept's limits, assumptions, failure conditions.
- analogy: generate an analogy and say where it breaks.
- prediction: a counterfactual / forward inference ("What happens to {system} if {variable} changes? Why?").
- exampleGen: the learner supplies their own instance of the concept.

CONTRACT (cards violating it are dropped): a subtype must match its kind; recall cards have a concrete back and NO rubric; every synthesis card MUST carry a valid rubric (>=1 criterion with non-empty description + positive weight, plus a non-empty modelAnswer). Favor a SPREAD of subtypes over a pile of cued cards — variety is a desirable difficulty. Aim for a balance of recall and synthesis cards.`

function buildUserPrompt(notePath: string, body: string): string {
  return `Generate flashcards from the note below (vault path: ${notePath}).\n\n--- NOTE START ---\n${body}\n--- NOTE END ---\n\nReturn the JSON array now.`
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
  opts: { model?: string } = {}
): Promise<GenerateFlashcardsResult> {
  const apiKey = await getAnthropicApiKey()
  if (!apiKey) throw new MissingAnthropicKeyError()

  const body = await fs.readFile(absolutePath(root, notePath), 'utf8')
  const model = opts.model?.trim() || DEFAULT_FLASHCARD_MODEL

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: FLASHCARD_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(notePath, body) }]
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
  return { drafts, dropped }
}

/** Convenience used by tests/manual flows: a fresh empty deck for a note. */
export { emptyDeck }
