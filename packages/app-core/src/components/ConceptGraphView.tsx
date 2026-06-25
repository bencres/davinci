import { useEffect, useMemo, type ReactNode } from 'react'
import { useStore } from '../store'
import type { ConceptGraph, ConceptNode } from '@shared/concept-graph'

interface Props {
  isActive: boolean
}

// Layout geometry.
const COL_W = 168 // horizontal slot per node
const ROW_H = 96 // vertical slot per (wrapped) row
const NODE_W = 140
const NODE_H = 46
const PER_ROW = 6 // wrap a depth band wider than this into multiple visual rows
const PAD = 32

/** Outer scroll container, matching the dashboard shell. */
function GraphShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-paper-100">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4 px-6 py-8">
        {children}
      </div>
    </div>
  )
}

/** Mastery → fill: untested grey, then a red→amber→green ramp by percent. */
function masteryFill(node: ConceptNode): string {
  if (node.total === 0) return '#e2e8f0' // slate-200 — depended on but untaught
  if (node.masteryPct <= 0) return '#cbd5e1' // slate-300 — has cards, never strengthened
  const hue = Math.round((node.masteryPct / 100) * 140) // 0 red → 140 green
  return `hsl(${hue} 62% 58%)`
}

/** Gap ring stroke (amber for weak foundations, dashed grey for untaught prereqs). */
function gapStroke(node: ConceptNode): { stroke: string; dash?: string; width: number } {
  if (!node.isGap) return { stroke: 'rgba(15,23,42,0.12)', width: 1 }
  if (node.gapReason === 'orphan-prereq') return { stroke: '#94a3b8', dash: '4 3', width: 2 }
  return { stroke: '#f59e0b', width: 2.5 } // unmet-prereq / weak
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

interface Placed {
  node: ConceptNode
  x: number // center
  y: number // center
}

interface Layout {
  placed: Placed[]
  posByKey: Map<string, Placed>
  width: number
  height: number
}

/** Layered top-down layout: foundational concepts (depth 0) on top, dependents
 *  below; wide depth bands wrap into multiple centered rows. */
function computeLayout(graph: ConceptGraph): Layout {
  const byDepth = new Map<number, ConceptNode[]>()
  let maxDepth = 0
  for (const node of graph.nodes) {
    const list = byDepth.get(node.depth) ?? []
    list.push(node)
    byDepth.set(node.depth, list)
    if (node.depth > maxDepth) maxDepth = node.depth
  }

  let maxCols = 1
  for (const list of byDepth.values()) maxCols = Math.max(maxCols, Math.min(PER_ROW, list.length))
  const width = Math.max(COL_W, maxCols * COL_W)

  const placed: Placed[] = []
  const posByKey = new Map<string, Placed>()
  let y = PAD + NODE_H / 2
  for (let d = 0; d <= maxDepth; d++) {
    const band = byDepth.get(d) ?? []
    for (let i = 0; i < band.length; i += PER_ROW) {
      const chunk = band.slice(i, i + PER_ROW)
      const rowW = chunk.length * COL_W
      const startX = (width - rowW) / 2 + COL_W / 2
      chunk.forEach((node, j) => {
        const p: Placed = { node, x: startX + j * COL_W, y }
        placed.push(p)
        posByKey.set(node.key, p)
      })
      y += ROW_H
    }
  }
  const height = y - ROW_H + NODE_H / 2 + PAD
  return { placed, posByKey, width: width + PAD * 2, height }
}

/** The concept (knowledge) graph: prerequisite-layered, mastery-colored, with gap rings. */
export function ConceptGraphView({ isActive }: Props): JSX.Element {
  const graph = useStore((s) => s.conceptGraph)
  const loading = useStore((s) => s.conceptGraphLoading)
  const error = useStore((s) => s.conceptGraphError)
  const loadConceptGraph = useStore((s) => s.loadConceptGraph)
  const startStudySession = useStore((s) => s.startStudySession)

  useEffect(() => {
    if (isActive) void loadConceptGraph()
  }, [isActive, loadConceptGraph])

  const layout = useMemo(() => (graph ? computeLayout(graph) : null), [graph])

  if (!graph || !layout) {
    return (
      <GraphShell>
        <div className="flex flex-1 items-center justify-center text-sm text-ink-500">
          {error ? <span className="text-rose-600">{error}</span> : loading ? 'Building the graph…' : '…'}
        </div>
      </GraphShell>
    )
  }

  if (graph.nodes.length === 0) {
    return (
      <GraphShell>
        <h1 className="text-lg font-semibold text-ink-900">Concept graph</h1>
        <div className="flex flex-1 items-center justify-center text-center text-sm text-ink-500">
          Generate flashcards with concepts and prerequisites to grow your knowledge graph.
        </div>
      </GraphShell>
    )
  }

  const offX = PAD
  return (
    <GraphShell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink-900">Concept graph</h1>
        <div className="flex flex-wrap items-center gap-3 text-2xs text-ink-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded" style={{ background: 'hsl(140 62% 58%)' }} /> mastered
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded" style={{ background: 'hsl(0 62% 58%)' }} /> weak
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-3 w-3 rounded ring-2 ring-amber-500" /> gap
          </span>
          {graph.hasCycle && <span className="text-amber-600">contains a prerequisite cycle</span>}
        </div>
      </div>
      <p className="text-2xs text-ink-500">
        Foundational concepts on top; arrows point to what builds on them. Click a concept to study it.
      </p>

      <div className="overflow-auto rounded-xl border border-paper-300 bg-paper-50">
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
          role="img"
          aria-label="Concept dependency graph"
        >
          <defs>
            <marker id="cg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="rgba(15,23,42,0.28)" />
            </marker>
          </defs>

          {/* edges (behind nodes) */}
          {graph.edges.map((e, i) => {
            const a = layout.posByKey.get(e.from)
            const b = layout.posByKey.get(e.to)
            if (!a || !b) return null
            const x1 = a.x + offX
            const y1 = a.y + NODE_H / 2
            const x2 = b.x + offX
            const y2 = b.y - NODE_H / 2
            const midY = (y1 + y2) / 2
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(15,23,42,0.18)"
                strokeWidth={1.25}
                markerEnd="url(#cg-arrow)"
              />
            )
          })}

          {/* nodes */}
          {layout.placed.map(({ node, x, y }) => {
            const cx = x + offX
            const ring = gapStroke(node)
            return (
              <g
                key={node.key}
                transform={`translate(${cx - NODE_W / 2}, ${y - NODE_H / 2})`}
                className="cursor-pointer"
                onClick={() => void startStudySession({ kind: 'concept', concept: node.concept })}
              >
                <title>
                  {`${node.concept}\n${node.mature}/${node.total} mastered · ${node.masteryPct}% mastery${
                    node.total > 0 && node.accuracy > 0 ? ` · ${Math.round(node.accuracy * 100)}% accuracy` : ''
                  }${node.isGap ? `\ngap: ${node.gapReason}` : ''}`}
                </title>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill={masteryFill(node)}
                  stroke={ring.stroke}
                  strokeWidth={ring.width}
                  strokeDasharray={ring.dash}
                />
                <text x={NODE_W / 2} y={NODE_H / 2 - 3} textAnchor="middle" className="fill-ink-900 text-[11px] font-medium">
                  {truncate(node.concept, 18)}
                </text>
                <text x={NODE_W / 2} y={NODE_H / 2 + 11} textAnchor="middle" className="fill-ink-700 text-[9px]">
                  {node.total === 0 ? 'no cards' : `${node.mature}/${node.total} · ${node.masteryPct}%`}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
    </GraphShell>
  )
}
