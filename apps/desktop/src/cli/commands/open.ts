/**
 * `zen open <file.md>` — open one or more markdown files in the ZenNotes
 * desktop app, whether or not they live inside a vault.
 *
 *   zen open ~/Downloads/notes.md
 *   zen open inbox/Today.md other.markdown
 *
 * We hand the file paths to the desktop app as launch arguments.
 * Electron's single-instance handling routes them to a running ZenNotes
 * (or starts one), where the open-file logic decides whether each file
 * is a vault note or a standalone file.
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { isMarkdownFilePath } from '../../main/file-open.js'
import { type ParsedArgs } from '../args.js'
import { emitOk } from '../format.js'

export async function cmdOpen(_vault: string, args: ParsedArgs): Promise<void> {
  if (args.positionals.length === 0) {
    throw new Error('zen open needs a file path. Usage: zen open <file.md> [more.md ...]')
  }

  const absPaths: string[] = []
  for (const target of args.positionals) {
    const abs = path.resolve(target)
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      throw new Error(`No such file: ${abs}`)
    }
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${abs}`)
    }
    if (!isMarkdownFilePath(abs)) {
      throw new Error(`zen open only supports markdown files (.md, .markdown): ${abs}`)
    }
    absPaths.push(abs)
  }

  // Re-launch our own binary in GUI mode. The CLI wrapper set
  // ELECTRON_RUN_AS_NODE so this process runs as plain Node, so we must
  // drop it for the child or it would start as Node too instead of the app.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.execPath, absPaths, {
    detached: true,
    stdio: 'ignore',
    env
  })
  child.unref()

  emitOk(
    absPaths.length === 1
      ? `Opening ${absPaths[0]} in ZenNotes`
      : `Opening ${absPaths.length} files in ZenNotes`
  )
}
