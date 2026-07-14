// Test environment builder for the plugins/strapped SessionStart hook scripts
// (sync-prs.sh and preamble.sh).
//
// Builds a temp state-root fixture (<stateRoot>/runs/<slug>/manifest.md and
// <stateRoot>/runs/<slug>/deliverables/*.md with given frontmatter), a bin dir
// holding symlinks to the coreutils the scripts need plus an optional stub
// `gh`, and a spawn helper that runs the REAL script with controlled HOME /
// PATH / STRAPPED_STATE_ROOT / cwd, so the user's real ~/.claude/strapped.json
// and real gh can never leak in.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE } from './node-bin.ts'

export const SYNC_PRS_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/sync-prs.sh', import.meta.url)
)

export const PREAMBLE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/preamble.sh', import.meta.url)
)

// Everything the hook scripts may exec besides gh. bash covers the stub gh's shebang.
const TOOLS = ['bash', 'grep', 'sed', 'basename', 'dirname', 'ls', 'head', 'cut', 'tr', 'timeout', 'git', 'cat', 'sort', 'uniq']

/** Frontmatter as raw `key: value` strings. */
export type RawFrontmatter = Record<string, string>

export interface RunOptions {
  script?: string
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface HookEnv {
  home: string
  stateRoot: string
  bin: string
  addDeliverable: (slug: string, filename: string, frontmatter: RawFrontmatter, body?: string) => string
  addManifest: (slug: string, frontmatter: RawFrontmatter, body?: string) => string
  readDeliverable: (slug: string, filename: string) => string
  run: (opts?: RunOptions) => SpawnSyncReturns<string>
}

function resolveTool(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  throw new Error(`cannot find ${name} on PATH`)
}

/**
 * Build an isolated environment for spawning a hook script (default sync-prs.sh).
 *
 * `gh` is the body of a stub `gh` script to put on PATH; omit (or pass null) to
 * build a PATH with coreutils but NO gh at all.
 */
export function makeHookEnv({ gh = null }: { gh?: string | null } = {}): HookEnv {
  const base = mkdtempSync(join(tmpdir(), 'strapped-hook-'))
  const home = join(base, 'home')
  const stateRoot = join(base, 'state')
  const bin = join(base, 'bin')
  mkdirSync(home)
  mkdirSync(stateRoot)
  mkdirSync(bin)

  for (const tool of TOOLS) symlinkSync(resolveTool(tool), join(bin, tool))
  // sync-prs.sh now shells to node (state.mjs cleanup/commit). Symlink the REAL
  // node binary (not a version-manager shim, which needs the real $HOME the hook
  // env deliberately isolates) so `command -v node` and the state.mjs calls work.
  symlinkSync(NODE, join(bin, 'node'))
  if (gh != null) {
    writeFileSync(join(bin, 'gh'), gh)
    chmodSync(join(bin, 'gh'), 0o755)
  }

  const deliverablePath = (slug: string, filename: string): string =>
    join(stateRoot, 'runs', slug, 'deliverables', filename)

  const addDeliverable = (slug: string, filename: string, frontmatter: RawFrontmatter, body = 'Body.'): string => {
    const dir = join(stateRoot, 'runs', slug, 'deliverables')
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = deliverablePath(slug, filename)
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const addManifest = (slug: string, frontmatter: RawFrontmatter, body = 'Body.'): string => {
    const dir = join(stateRoot, 'runs', slug)
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = join(dir, 'manifest.md')
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const readDeliverable = (slug: string, filename: string): string =>
    readFileSync(deliverablePath(slug, filename), 'utf8')

  const run = ({ script = SYNC_PRS_SCRIPT, cwd = home, env = {} }: RunOptions = {}): SpawnSyncReturns<string> =>
    spawnSync(join(bin, 'bash'), [script], {
      cwd,
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: bin,
        STRAPPED_STATE_ROOT: stateRoot,
        ...env,
      },
    })

  return { home, stateRoot, bin, addDeliverable, addManifest, readDeliverable, run }
}

/** A stub `gh` that passes `gh auth status` and answers `gh pr view` with the given compact JSON. */
export function ghStub(prViewJson: string): string {
  return `#!/usr/bin/env bash
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ]; then printf '%s\\n' '${prViewJson}'; exit 0; fi
exit 1
`
}
