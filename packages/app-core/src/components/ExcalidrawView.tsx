import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { Excalidraw, serializeAsJSON } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { parseExcalidrawDocument } from '@shared/excalidraw'
import { useStore } from '../store'
import { THEMES } from '../lib/themes'

type InitialData = ComponentProps<typeof Excalidraw>['initialData']
type ChangeHandler = NonNullable<ComponentProps<typeof Excalidraw>['onChange']>
type SceneArgs = Parameters<ChangeHandler>

/**
 * The embedded Excalidraw drawing editor for a `.excalidraw` file. Loaded lazily
 * (see LazyExcalidrawView) so the heavy bundle never touches startup. Reads the
 * scene JSON from disk on open and debounce-saves it back on every change.
 */
export function ExcalidrawView({
  path,
  viewMode = false
}: {
  path: string
  /** Read-only mode: hides the editing UI and skips the save loop. Used by inline
   *  `![[drawing.excalidraw]]` embeds rendered in the Preview pane. */
  viewMode?: boolean
}): JSX.Element {
  const [initialData, setInitialData] = useState<InitialData | undefined>(undefined)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef<string>('')
  const latestScene = useRef<SceneArgs | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  // Match the app's light/dark theme.
  const themeId = useStore((s) => s.themeId)
  const excalidrawTheme = THEMES.find((t) => t.id === themeId)?.mode === 'dark' ? 'dark' : 'light'

  // Persist the latest scene to `targetPath`. Shared by the debounce and every
  // flush point (navigate-away, drawing switch, app hide/quit) so leaving the
  // drawing always writes — letting the inline `![[…]]` embed update without an
  // explicit save. `writeNote` is fire-and-forget, so it still completes as the
  // component unmounts. The no-op guard skips Excalidraw's load/hover onChange.
  const flushSave = useCallback((targetPath: string) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const scene = latestScene.current
    if (!scene) return
    let json: string
    try {
      json = serializeAsJSON(scene[0], scene[1], scene[2], 'local')
    } catch {
      return
    }
    if (json === lastSaved.current) return
    lastSaved.current = json
    void window.zen.writeNote(targetPath, json)
  }, [])

  useEffect(() => {
    let cancelled = false
    // Don't let a new drawing inherit the previous one's pending scene.
    latestScene.current = null
    setInitialData(undefined)
    window.zen
      .readNote(path)
      .then((res) => {
        if (cancelled) return
        lastSaved.current = res?.body ?? ''
        const doc = parseExcalidrawDocument(res?.body ?? '')
        setInitialData({
          elements: doc.elements,
          appState: doc.appState,
          files: doc.files
        } as InitialData)
      })
      .catch(() => {
        if (!cancelled) setInitialData({} as InitialData)
      })
    return () => {
      cancelled = true
      // Flush to the path we were editing (the old `path` in this closure) —
      // covers both navigating away (unmount) and switching to another drawing.
      flushSave(path)
    }
  }, [path, flushSave])

  // Flush when the app is hidden or closed so the latest scene survives a quit.
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushSave(pathRef.current)
    }
    const onPageHide = (): void => flushSave(pathRef.current)
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [flushSave])

  if (initialData === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">
        Loading drawing…
      </div>
    )
  }

  return (
    <div className="min-h-0 w-full flex-1" style={{ height: '100%' }}>
      <Excalidraw
        initialData={initialData}
        theme={excalidrawTheme}
        viewModeEnabled={viewMode}
        onChange={viewMode ? undefined : (elements, appState, files) => {
          latestScene.current = [elements, appState, files]
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => flushSave(pathRef.current), 700)
        }}
      />
    </div>
  )
}
