import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() }))
}))

import { spawn } from 'node:child_process'
import { cmdOpen } from './open'
import type { ParsedArgs } from '../args'

function makeArgs(positionals: string[]): ParsedArgs {
  return { positionals, flags: new Map() }
}

let tmpDir: string
let mdFile: string
let markdownFile: string
let txtFile: string

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'zen-open-'))
  mdFile = path.join(tmpDir, 'note.md')
  markdownFile = path.join(tmpDir, 'other.markdown')
  txtFile = path.join(tmpDir, 'note.txt')
  await fsp.writeFile(mdFile, '# hi\n')
  await fsp.writeFile(markdownFile, '# hello\n')
  await fsp.writeFile(txtFile, 'hi\n')
})

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  vi.mocked(spawn).mockClear()
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
})

describe('cmdOpen', () => {
  it('rejects when no path is given', async () => {
    await expect(cmdOpen('', makeArgs([]))).rejects.toThrow(/needs a file path/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a non-markdown file', async () => {
    await expect(cmdOpen('', makeArgs([txtFile]))).rejects.toThrow(/markdown/)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a missing file', async () => {
    await expect(cmdOpen('', makeArgs([path.join(tmpDir, 'nope.md')]))).rejects.toThrow(
      /No such file/
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('launches the app with the resolved path, GUI mode', async () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_RUN_AS_NODE = '1'
    try {
      await cmdOpen('', makeArgs([mdFile]))
    } finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE
      else process.env.ELECTRON_RUN_AS_NODE = prev
    }
    expect(spawn).toHaveBeenCalledTimes(1)
    const [bin, argv, opts] = vi.mocked(spawn).mock.calls[0]
    expect(bin).toBe(process.execPath)
    expect(argv).toEqual([mdFile])
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' })
    // The CLI runs as Node via ELECTRON_RUN_AS_NODE; the child must launch
    // as the GUI app, so that flag must be stripped.
    const childEnv = (opts as { env?: NodeJS.ProcessEnv }).env ?? {}
    expect(childEnv.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('opens multiple files in a single launch', async () => {
    await cmdOpen('', makeArgs([mdFile, markdownFile]))
    expect(spawn).toHaveBeenCalledTimes(1)
    const [, argv] = vi.mocked(spawn).mock.calls[0]
    expect(argv).toEqual([mdFile, markdownFile])
  })

  it('rejects the whole batch if any file is invalid', async () => {
    await expect(cmdOpen('', makeArgs([mdFile, txtFile]))).rejects.toThrow(/markdown/)
    expect(spawn).not.toHaveBeenCalled()
  })
})
