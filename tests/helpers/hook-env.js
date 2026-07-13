// Test environment builder for the plugins/strapped SessionStart hook scripts
// (sync-prs.sh and preamble.sh).
//
// Builds a temp state-root fixture (<stateRoot>/runs/<slug>/manifest.md and
// <stateRoot>/runs/<slug>/deliverables/*.md with given frontmatter), a bin dir
// holding symlinks to the coreutils the scripts need plus an optional stub
// `gh`, and a spawn helper that runs the REAL script with controlled HOME /
// PATH / STRAPPED_STATE_ROOT / cwd, so the user's real ~/.claude/strapped.json
// and real gh can never leak in.

import { spawnSync } from 'node:child_process'
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

export const SYNC_PRS_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/sync-prs.sh', import.meta.url)
)

export const PREAMBLE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/preamble.sh', import.meta.url)
)

// Everything the hook scripts may exec besides gh. bash covers the stub gh's shebang.
const TOOLS = ['bash', 'grep', 'sed', 'basename', 'dirname', 'ls', 'head', 'cut', 'tr', 'timeout', 'git', 'cat', 'sort', 'uniq']

function resolveTool(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && existsSync(join(dir, name))) return join(dir, name)
  }
  throw new Error(`cannot find ${name} on PATH`)
}

/**
 * Build an isolated environment for spawning a hook script (default sync-prs.sh).
 *
 * @param {object} [opts]
 * @param {string|null} [opts.gh] body of a stub `gh` script to put on PATH;
 *   omit (or pass null) to build a PATH with coreutils but NO gh at all.
 * @returns {{
 *   home: string, stateRoot: string, bin: string,
 *   addDeliverable: (slug: string, filename: string, frontmatter: object, body?: string) => string,
 *   addManifest: (slug: string, frontmatter: object, body?: string) => string,
 *   readDeliverable: (slug: string, filename: string) => string,
 *   run: (opts?: {script?: string, cwd?: string, env?: object}) => import('node:child_process').SpawnSyncReturns<string>
 * }}
 */
export function makeHookEnv({ gh = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'strapped-hook-'))
  const home = join(base, 'home')
  const stateRoot = join(base, 'state')
  const bin = join(base, 'bin')
  mkdirSync(home)
  mkdirSync(stateRoot)
  mkdirSync(bin)

  for (const tool of TOOLS) symlinkSync(resolveTool(tool), join(bin, tool))
  if (gh != null) {
    writeFileSync(join(bin, 'gh'), gh)
    chmodSync(join(bin, 'gh'), 0o755)
  }

  const deliverablePath = (slug, filename) =>
    join(stateRoot, 'runs', slug, 'deliverables', filename)

  const addDeliverable = (slug, filename, frontmatter, body = 'Body.') => {
    const dir = join(stateRoot, 'runs', slug, 'deliverables')
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = deliverablePath(slug, filename)
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const addManifest = (slug, frontmatter, body = 'Body.') => {
    const dir = join(stateRoot, 'runs', slug)
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = join(dir, 'manifest.md')
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const readDeliverable = (slug, filename) => readFileSync(deliverablePath(slug, filename), 'utf8')

  const run = ({ script = SYNC_PRS_SCRIPT, cwd = home, env = {} } = {}) =>
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
export function ghStub(prViewJson) {
  return `#!/usr/bin/env bash
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "pr" ]; then printf '%s\\n' '${prViewJson}'; exit 0; fi
exit 1
`
}
