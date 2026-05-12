import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const stylesSource = readFileSync(new URL('../styles/index.css', import.meta.url), 'utf8')

describe('editor and preview typography rhythm', () => {
  it('uses the same content line-height for editor and preview headings', () => {
    expect(stylesSource).toMatch(
      /\.cm-editor\s*\{[^}]*--z-heading-line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-heading-line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
  })

  it('maps preview block spacing to the shared split-view rhythm and removes extra editor heading padding', () => {
    expect(stylesSource).toMatch(/\.cm-editor\s*\{[^}]*--z-heading-bottom-gap:\s*0px;/s)
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-line-gap:\s*calc\(var\(--z-editor-line-height,\s*1\.7\)\s*\*\s*1em\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-rendered-gap:\s*calc\(var\(--z-prose-line-gap\)\s*\*\s*0\.6\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-block-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-section-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen\s*\{[^}]*--z-prose-heading-gap:\s*var\(--z-prose-rendered-gap\);/s
    )
    expect(stylesSource).toMatch(/\.prose-zen h1\s*\{[^}]*margin-bottom:\s*var\(--z-prose-heading-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h2\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h3\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h4\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h5\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
    expect(stylesSource).toMatch(/\.prose-zen h6\s*\{[^}]*margin-top:\s*var\(--z-prose-section-gap\);/s)
  })

  it('keeps rendered code blocks on the same text rhythm as the editor', () => {
    expect(stylesSource).toMatch(/\.prose-zen pre code\s*\{[^}]*font-size:\s*1em;/s)
    expect(stylesSource).toMatch(
      /\.prose-zen pre code\s*\{[^}]*line-height:\s*var\(--z-editor-line-height,\s*1\.7\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen \.zen-code-block\s*\{[^}]*--z-code-toolbar-line:\s*max\(var\(--z-prose-line-gap\),\s*28px\);/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen \.zen-code-block pre\s*\{[^}]*padding:\s*var\(--z-code-toolbar-line\)\s*16px\s*var\(--z-prose-line-gap\);/s
    )
  })

  it('keeps content letter spacing neutral', () => {
    expect(stylesSource).not.toMatch(/letter-spacing:\s*-/)
    expect(stylesSource).toMatch(
      /\.cm-editor \.tok-heading5\s*\{[^}]*letter-spacing:\s*0;/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen h1,\s*\.prose-zen h2,\s*\.prose-zen h3,\s*\.prose-zen h4,\s*\.prose-zen h5,\s*\.prose-zen h6\s*\{[^}]*letter-spacing:\s*0;/s
    )
    expect(stylesSource).toMatch(
      /\.prose-zen h5\s*\{[^}]*letter-spacing:\s*0;/s
    )
  })
})
