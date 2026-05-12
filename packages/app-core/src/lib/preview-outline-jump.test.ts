// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  findOutlineHeadingIndex,
  findRenderedHeadingForOutlineLine,
  nextOutlinePreviewSyncLockUntil,
  outlineHeadingTextOffset,
  previewScrollTopForHeading,
  scrollTopForElementRelativeTop
} from './preview-outline-jump'
import type { OutlineItem } from './outline'

const outline: OutlineItem[] = [
  { level: 1, text: 'Intro', line: 1, from: 0 },
  { level: 2, text: 'Middle', line: 24, from: 400 },
  { level: 2, text: 'Target', line: 72, from: 1200 }
]

describe('preview outline jump helpers', () => {
  it('maps an outline line to the matching rendered heading index', () => {
    const root = document.createElement('article')
    root.innerHTML = '<h1>Intro</h1><p>body</p><h2>Middle</h2><h2>Target</h2>'

    expect(findOutlineHeadingIndex(outline, 72)).toBe(2)
    expect(findRenderedHeadingForOutlineLine(root, outline, 72)?.textContent).toBe('Target')
    expect(findRenderedHeadingForOutlineLine(root, outline, 99)).toBeNull()
  })

  it('targets the rendered heading text instead of the markdown marker', () => {
    expect(outlineHeadingTextOffset('# Intro')).toBe(2)
    expect(outlineHeadingTextOffset('###### Deep heading')).toBe(7)
    expect(outlineHeadingTextOffset('Plain text')).toBe(0)
  })

  it('computes a bounded preview scroll top for a rendered heading', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 120, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 260 } as DOMRect)

    expect(previewScrollTopForHeading(preview, heading, 24)).toBe(336)
  })

  it('keeps a rendered element at the same viewport offset as its editor anchor', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 120, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 180 } as DOMRect)

    expect(scrollTopForElementRelativeTop(preview, heading, 72)).toBe(208)
  })

  it('clamps preview scroll targets to the available scroll range', () => {
    const preview = document.createElement('div')
    const heading = document.createElement('h2')
    Object.defineProperty(preview, 'scrollTop', { value: 650, writable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 1000 })
    Object.defineProperty(preview, 'clientHeight', { value: 300 })
    preview.getBoundingClientRect = () => ({ top: 20 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 260 } as DOMRect)

    expect(previewScrollTopForHeading(preview, heading, 24)).toBe(700)
  })

  it('extends the outline preview sync lock without shortening an active lock', () => {
    expect(nextOutlinePreviewSyncLockUntil(100, 450, 0)).toBe(550)
    expect(nextOutlinePreviewSyncLockUntil(125, 100, 550)).toBe(550)
    expect(nextOutlinePreviewSyncLockUntil(600, 100, 550)).toBe(700)
  })
})
