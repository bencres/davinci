/**
 * Concept dependency graph — derived (never stored) from the same decks + review
 * logs the dashboard reads. Nodes are concepts (with their mastery rollup),
 * edges are prerequisite → concept relationships taken from the `prerequisites`
 * field every card already carries, and `gaps` are weak/missing foundations.
 *
 * PURE (no node/DOM imports) so it is unit-testable and shared by the renderer.
 * It powers the concept-graph view and the dashboard "gaps" list. No FSRS
 * scheduler enforcement happens here — this is data + visualization only.
 *
 * Concept labels are free-text (authored by Claude), so they are matched by a
 * normalized key (trimmed + lower-cased) while the first-seen display form is
 * preserved. Free-text prerequisites can form cycles; depth computation breaks
 * back-edges so the layered layout stays acyclic, and `hasCycle` records it.
 */

import type { FlashcardDeck, ReviewLogFile } from './flashcards'
import { computeConceptMastery, conceptKey, type ConceptMastery } from './study-stats'

export { conceptKey }

/** Mastery (0..100) below which a concept counts as a gap worth shoring up. */
export const WEAK_MASTERY_THRESHOLD = 34

export type GapReason =
  | 'orphan-prereq' // depended on as a prerequisite but no cards teach it
  | 'unmet-prereq' // weak, and other concepts build on it
  | 'weak' // weak mastery, nothing depends on it

export interface ConceptNode extends ConceptMastery {
  /** Normalized matching key (trim + lower-case of `concept`). */
  key: string
  /** Longest prerequisite-chain depth (0 = foundational); back-edges broken. */
  depth: number
  isGap: boolean
  gapReason?: GapReason
}

/** A directed prerequisite edge: `from` must be learned before `to` (normalized keys). */
export interface ConceptEdge {
  from: string
  to: string
}

export interface ConceptGap {
  key: string
  concept: string
  reason: GapReason
  masteryPct: number
}

export interface ConceptGraph {
  nodes: ConceptNode[]
  edges: ConceptEdge[]
  gaps: ConceptGap[]
  /** True when prerequisite edges form at least one cycle (back-edges were broken). */
  hasCycle: boolean
}

/**
 * Build the concept dependency graph from every deck + review log. `now` is
 * reserved for future recency weighting; mastery already reflects current SRS
 * state, so the graph needs no review history to be useful.
 */
export function buildConceptGraph(
  decks: FlashcardDeck[],
  logs: ReviewLogFile[],
  _now: Date = new Date()
): ConceptGraph {
  // 1. Concept nodes from the shared mastery rollup.
  const mastery = computeConceptMastery(decks, logs)
  const nodeByKey = new Map<string, ConceptNode>()
  for (const m of mastery) {
    const key = conceptKey(m.concept)
    if (key && !nodeByKey.has(key)) {
      nodeByKey.set(key, { ...m, key, depth: 0, isGap: false })
    }
  }

  // 2. Prerequisite edges: each card's prerequisites point at its focus concept.
  //    Unknown prerequisites get a synthetic node (no cards teach them). Edges are
  //    de-duplicated with a nested set (from → set of tos) so concept keys can
  //    safely contain any character — no flat string key / separator to collide on.
  const seenTos = new Map<string, Set<string>>()
  const edges: ConceptEdge[] = []
  for (const deck of decks) {
    for (const card of deck.cards) {
      const focus = card.concepts[0]
      if (!focus) continue
      const toKey = conceptKey(focus)
      if (!toKey) continue
      for (const prereq of card.prerequisites) {
        const fromKey = conceptKey(prereq)
        if (!fromKey || fromKey === toKey) continue
        if (!nodeByKey.has(fromKey)) {
          nodeByKey.set(fromKey, {
            concept: prereq.trim(),
            total: 0,
            mature: 0,
            accuracy: 0,
            masteryPct: 0,
            notePaths: [],
            key: fromKey,
            depth: 0,
            isGap: false
          })
        }
        let tos = seenTos.get(fromKey)
        if (!tos) {
          tos = new Set<string>()
          seenTos.set(fromKey, tos)
        }
        if (!tos.has(toKey)) {
          tos.add(toKey)
          edges.push({ from: fromKey, to: toKey })
        }
      }
    }
  }

  // 3. Depth = longest prerequisite chain into a node (back-edges broken).
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const pushTo = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }
  for (const e of edges) {
    pushTo(incoming, e.to, e.from)
    pushTo(outgoing, e.from, e.to)
  }
  const depth = new Map<string, number>()
  const onStack = new Set<string>()
  let hasCycle = false
  const computeDepth = (key: string): number => {
    const cached = depth.get(key)
    if (cached != null) return cached
    if (onStack.has(key)) {
      hasCycle = true
      return 0 // back-edge: ignore its contribution
    }
    onStack.add(key)
    let d = 0
    for (const from of incoming.get(key) ?? []) d = Math.max(d, computeDepth(from) + 1)
    onStack.delete(key)
    depth.set(key, d)
    return d
  }
  for (const key of nodeByKey.keys()) {
    const node = nodeByKey.get(key)!
    node.depth = computeDepth(key)
  }

  // 4. Gap detection (no history needed — reads current mastery + edges).
  const gaps: ConceptGap[] = []
  for (const node of nodeByKey.values()) {
    const dependents = outgoing.get(node.key)?.length ?? 0
    let reason: GapReason | undefined
    if (node.total === 0) {
      // synthetic prerequisite node — nothing teaches it
      reason = 'orphan-prereq'
    } else if (node.masteryPct < WEAK_MASTERY_THRESHOLD) {
      reason = dependents > 0 ? 'unmet-prereq' : 'weak'
    }
    if (reason) {
      node.isGap = true
      node.gapReason = reason
      gaps.push({ key: node.key, concept: node.concept, reason, masteryPct: node.masteryPct })
    }
  }
  // Rank: foundations others depend on first, then orphans, then plain-weak;
  // within a reason, weakest mastery first, then bigger concepts.
  const reasonRank: Record<GapReason, number> = { 'unmet-prereq': 0, 'orphan-prereq': 1, weak: 2 }
  gaps.sort(
    (a, b) =>
      reasonRank[a.reason] - reasonRank[b.reason] ||
      a.masteryPct - b.masteryPct ||
      a.concept.localeCompare(b.concept)
  )

  const nodes = [...nodeByKey.values()].sort(
    (a, b) => a.depth - b.depth || b.total - a.total || a.concept.localeCompare(b.concept)
  )
  return { nodes, edges, gaps, hasCycle }
}

/**
 * The target concept plus all of its transitive prerequisites, ordered
 * foundational-first (by graph depth). Powers "prerequisite-ordered" study:
 * shore up what a concept depends on before the concept itself. Matching is by
 * normalized key; cycles in the free-text prerequisite graph are tolerated via a
 * visited set. Returns normalized keys; returns just the target when it has no
 * prerequisites (or isn't in the graph).
 */
export function prerequisiteChain(graph: ConceptGraph, targetConcept: string): string[] {
  const targetKey = conceptKey(targetConcept)
  if (!targetKey) return []
  // Backward adjacency: for each concept, the prerequisites pointing into it.
  const incoming = new Map<string, string[]>()
  for (const e of graph.edges) {
    const list = incoming.get(e.to)
    if (list) list.push(e.from)
    else incoming.set(e.to, [e.from])
  }
  const visited = new Set<string>([targetKey])
  const stack = [targetKey]
  while (stack.length > 0) {
    const key = stack.pop()!
    for (const from of incoming.get(key) ?? []) {
      if (!visited.has(from)) {
        visited.add(from)
        stack.push(from)
      }
    }
  }
  const depthOf = new Map(graph.nodes.map((n) => [n.key, n.depth]))
  return [...visited].sort(
    (a, b) => (depthOf.get(a) ?? 0) - (depthOf.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0)
  )
}
