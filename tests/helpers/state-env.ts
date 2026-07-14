// Test environment builder for plugins/strapped/scripts/state.mjs and
// ensure-worktree.sh — modeled on hook-env.js.
//
// Builds a temp state-root fixture (<stateRoot>/runs/<slug>/{manifest.md,
// deliverables/*.md} in the exact conventions.md file shapes, plus
// <stateRoot>/repos/<name>/config.json) and spawn helpers that run the REAL
// scripts with an isolated HOME and a controlled STRAPPED_STATE_ROOT, so the
// user's real ~/.claude/strapped.json can never leak in.

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NODE } from './node-bin.ts'

export const STATE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/state.mjs', import.meta.url)
)
export const ENSURE_WORKTREE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/ensure-worktree.sh', import.meta.url)
)

/** Frontmatter as raw `key: value` strings. */
export type RawFrontmatter = Record<string, string>

export interface ManifestRepoSpec {
  name: string
  root: string
  config?: string
}

export interface ManifestDeliverableSpec {
  id: string
  file: string
  deps?: string[]
}

export interface ManifestOptions {
  stateRoot?: string
  status?: string
  seed?: number
  budgets?: Record<string, number>
  repos?: ManifestRepoSpec[]
  deliverables?: ManifestDeliverableSpec[]
}

/** A deliverable spec for writeRun: id + deps plus raw frontmatter overrides. */
export interface RunSpec {
  id: string
  deps?: string[]
  status?: string
  parked_reason?: string
}

/** Full canonical deliverable frontmatter (values as raw frontmatter strings). */
export function deliverableFrontmatter(id: string, overrides: Partial<RawFrontmatter> = {}): RawFrontmatter {
  const base: RawFrontmatter = {
    id,
    title: `Deliverable ${id}`,
    deps: '[]',
    repo: 'repo-a',
    status: 'pending',
    branch: `strapped/my-run/${id}-thing`,
    base: 'main',
    worktree: 'null',
    pr: 'null',
    review_rounds_used: '0',
    feedback_rounds_used: '0',
    parked_reason: 'null',
    estimated_diff_lines: '100',
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v
  }
  return base
}

export function makeStateEnv() {
  const base = mkdtempSync(join(tmpdir(), 'strapped-state-'))
  const home = join(base, 'home')
  const stateRoot = join(base, 'state')
  mkdirSync(home)
  mkdirSync(stateRoot)

  const runDir = (slug: string): string => join(stateRoot, 'runs', slug)

  /** Write a conventions-shaped manifest.md (nested budgets map, inline-flow repos/deliverables lists). */
  const writeManifest = (
    slug: string,
    {
      stateRoot: rootOverride,
      status = 'approved',
      seed = 42,
      budgets = { plan_rounds: 3, code_rounds: 3, confidence_min: 70 },
      repos = [],
      deliverables = [],
    }: ManifestOptions = {}
  ): string => {
    const root = rootOverride ?? stateRoot
    const dir = join(root, 'runs', slug)
    mkdirSync(dir, { recursive: true })
    const lines = [
      '---',
      `slug: ${slug}`,
      `source_plan: plans/${slug}.md`,
      'created: 2026-07-11',
      `status: ${status}`,
      `seed: ${seed}`,
      'budgets:',
      ...Object.entries(budgets).map(([k, v]) => `  ${k}: ${v}`),
      'repos:',
      ...repos.map(
        r =>
          `  - { name: ${r.name}, root: ${r.root}, config: ${r.config ?? join(root, 'repos', r.name, 'config.json')} }`
      ),
      'deliverables:',
      ...deliverables.map(
        d => `  - { id: ${d.id}, file: ${d.file}, deps: [${(d.deps ?? []).join(', ')}] }`
      ),
      '---',
      `# ${slug}`,
    ]
    const file = join(dir, 'manifest.md')
    writeFileSync(file, lines.join('\n') + '\n')
    return file
  }

  const addDeliverable = (slug: string, filename: string, frontmatter: RawFrontmatter, body = 'Body.'): string => {
    const dir = join(runDir(slug), 'deliverables')
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = join(dir, filename)
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const addRepoConfig = (name: string, config: unknown): string => {
    const dir = join(stateRoot, 'repos', name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(config, null, 2))
    return file
  }

  /** Build a whole run from [{id, deps, status, ...frontmatter overrides}] specs; returns the run dir. */
  const writeRun = (slug: string, specs: RunSpec[], manifestOpts: ManifestOptions = {}): string => {
    writeManifest(slug, {
      repos: [{ name: 'repo-a', root: '/abs/repo-a' }],
      deliverables: specs.map(s => ({ id: s.id, file: `deliverables/${s.id}-x.md`, deps: s.deps ?? [] })),
      ...manifestOpts,
    })
    for (const { id, deps = [], ...overrides } of specs) {
      addDeliverable(slug, `${id}-x.md`, deliverableFrontmatter(id, { deps: `[${deps.join(', ')}]`, ...overrides }))
    }
    return runDir(slug)
  }

  /** Spawn the real state.mjs (under node — deploy parity) with isolated HOME + STRAPPED_STATE_ROOT. */
  const runState = (
    args: string[],
    { env = {} }: { env?: Record<string, string | undefined> } = {}
  ): SpawnSyncReturns<string> =>
    spawnSync(NODE, [STATE_SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: process.env.PATH,
        STRAPPED_STATE_ROOT: stateRoot,
        ...env,
      },
    })

  const readFile = (file: string): string => readFileSync(file, 'utf8')

  return { base, home, stateRoot, runDir, writeManifest, addDeliverable, addRepoConfig, writeRun, runState, readFile }
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

/** A real temp git repo with one commit on main, plus a bound git() helper. */
export function makeGitRepo(): { dir: string; git: (...args: string[]) => SpawnSyncReturns<string> } {
  const dir = mkdtempSync(join(tmpdir(), 'strapped-repo-'))
  const git = (...args: string[]): SpawnSyncReturns<string> => {
    const res = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    return res
  }
  git('init', '--quiet', '-b', 'main', dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  git('-C', dir, 'add', '.')
  git('-C', dir, 'commit', '--quiet', '-m', 'init')
  return { dir, git: (...args: string[]) => git('-C', dir, ...args) }
}

/** Spawn the real ensure-worktree.sh (missing trailing args are simply not passed). */
export function runEnsureWorktree(...args: (string | undefined)[]): SpawnSyncReturns<string> {
  return spawnSync('bash', [ENSURE_WORKTREE_SCRIPT, ...args.filter((a): a is string => a !== undefined)], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  })
}
