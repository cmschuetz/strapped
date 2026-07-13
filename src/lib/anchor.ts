// Reading the strapped anchor file ~/.claude/strapped.json — the ONLY global
// config source ($HOME-relative, cwd-independent). Used by resolve-chain for
// its `chains` overlay; the state CLI joins in D2.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Absolute path of the anchor file, honoring $HOME (tests isolate via HOME). */
export function anchorPath(): string {
  const home = process.env.HOME || homedir()
  return join(home, '.claude', 'strapped.json')
}

/**
 * Read and JSON-parse the anchor file.
 * Returns undefined when the file does not exist; throws (SyntaxError) when it
 * exists but is not valid JSON — callers own the error message.
 */
export function readAnchor(): unknown {
  const path = anchorPath()
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Property access on an unknown value without casts at every call site. */
export function getProp(value: unknown, key: string): unknown {
  if (typeof value === 'object' && value !== null && key in value) {
    return (value as Record<string, unknown>)[key]
  }
  return undefined
}
