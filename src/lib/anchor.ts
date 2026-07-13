// Reading the strapped anchor file ~/.claude/strapped.json — the ONLY global
// config source ($HOME-relative, cwd-independent). Used by resolve-chain for
// its `chains` overlay and by the state CLI for `stateRoot` resolution.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

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

/**
 * Resolve the strapped state root: $STRAPPED_STATE_ROOT → anchor `stateRoot` →
 * default ~/.claude/strapped. Supports `~` expansion; rejects relative paths.
 * Misuse messages go through the caller's `die` so each CLI keeps its own
 * stderr prefix.
 */
export function resolveStateRoot(die: (msg: string) => never): string {
  const home = process.env.HOME || homedir()
  let value: string | null = null
  let source: string | null = null
  if (process.env.STRAPPED_STATE_ROOT) {
    value = process.env.STRAPPED_STATE_ROOT
    source = '$STRAPPED_STATE_ROOT'
  } else {
    const anchor = anchorPath()
    let parsed: unknown
    try {
      parsed = readAnchor()
    } catch {
      die(`invalid JSON in anchor file ${anchor}`)
    }
    const configured = getProp(parsed, 'stateRoot')
    if (typeof configured === 'string' && configured !== '') {
      value = configured
      source = anchor
    }
    if (value === null) {
      value = join(home, '.claude', 'strapped')
      source = 'default'
    }
  }
  if (value === '~' || value.startsWith('~/')) value = home + value.slice(1)
  if (!isAbsolute(value)) die(`stateRoot is not absolute: "${value}" (from ${source})`)
  return value
}
