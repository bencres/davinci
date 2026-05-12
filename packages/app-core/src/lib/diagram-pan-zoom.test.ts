import { describe, expect, it } from 'vitest'
import {
  DIAGRAM_ZOOM_MAX,
  DIAGRAM_ZOOM_MIN,
  clampDiagramZoom,
  diagramZoomLabel,
  fitDiagramToViewport,
  stepDiagramZoom,
  zoomDiagramAtPoint
} from './diagram-pan-zoom'

describe('diagram pan/zoom helpers', () => {
  it('clamps zoom to the supported expanded-diagram range', () => {
    expect(clampDiagramZoom(0.01)).toBe(DIAGRAM_ZOOM_MIN)
    expect(clampDiagramZoom(12)).toBe(DIAGRAM_ZOOM_MAX)
    expect(clampDiagramZoom(Number.NaN)).toBe(1)
  })

  it('steps zoom in fixed increments', () => {
    expect(stepDiagramZoom(1, 1)).toBe(1.2)
    expect(stepDiagramZoom(1, -1)).toBe(0.8)
  })

  it('keeps the diagram point under the cursor stable while zooming', () => {
    const next = zoomDiagramAtPoint(
      { zoom: 1, pan: { x: 25, y: 40 } },
      2,
      { x: 125, y: 140 }
    )

    expect(next.zoom).toBe(2)
    expect(next.pan).toEqual({ x: -75, y: -60 })
  })

  it('formats zoom as a rounded percentage', () => {
    expect(diagramZoomLabel(1.234)).toBe('123%')
  })

  it('fits large diagrams inside the viewport without upscaling small diagrams', () => {
    expect(
      fitDiagramToViewport(
        { width: 1000, height: 500 },
        { width: 2000, height: 1000 },
        0
      )
    ).toEqual({ zoom: 0.5, pan: { x: 0, y: 0 } })

    expect(
      fitDiagramToViewport(
        { width: 1000, height: 500 },
        { width: 300, height: 200 },
        0
      ).zoom
    ).toBe(1)
  })
})
