export const DIAGRAM_ZOOM_MIN = 0.25
export const DIAGRAM_ZOOM_MAX = 4
export const DIAGRAM_ZOOM_STEP = 0.2
export const DIAGRAM_FIT_PADDING = 28

export interface DiagramPoint {
  x: number
  y: number
}

export interface DiagramPanZoomState {
  zoom: number
  pan: DiagramPoint
}

export function clampDiagramZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, value))
}

export function stepDiagramZoom(current: number, direction: 1 | -1): number {
  return clampDiagramZoom(current + DIAGRAM_ZOOM_STEP * direction)
}

export function zoomDiagramAtPoint(
  state: DiagramPanZoomState,
  nextZoomRaw: number,
  point: DiagramPoint,
): DiagramPanZoomState {
  const zoom = clampDiagramZoom(state.zoom)
  const nextZoom = clampDiagramZoom(nextZoomRaw)
  if (nextZoom === zoom) return { zoom, pan: state.pan }

  const contentX = (point.x - state.pan.x) / zoom
  const contentY = (point.y - state.pan.y) / zoom

  return {
    zoom: nextZoom,
    pan: {
      x: point.x - contentX * nextZoom,
      y: point.y - contentY * nextZoom,
    },
  }
}

export function diagramZoomLabel(zoom: number): string {
  return `${Math.round(clampDiagramZoom(zoom) * 100)}%`
}

export function fitDiagramToViewport(
  viewport: { width: number; height: number },
  content: { width: number; height: number },
  padding = DIAGRAM_FIT_PADDING,
): DiagramPanZoomState {
  const availableWidth = Math.max(1, viewport.width - padding * 2)
  const availableHeight = Math.max(1, viewport.height - padding * 2)
  const contentWidth = Math.max(1, content.width)
  const contentHeight = Math.max(1, content.height)
  const zoom = clampDiagramZoom(
    Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight),
  )

  return {
    zoom,
    pan: {
      x: Math.max(padding, (viewport.width - contentWidth * zoom) / 2),
      y: Math.max(padding, (viewport.height - contentHeight * zoom) / 2),
    },
  }
}
