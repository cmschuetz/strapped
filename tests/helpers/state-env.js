// Test environment builder for plugins/strapped/scripts/state.mjs and
// ensure-worktree.sh — modeled on hook-env.js.
//
// Builds a temp state-root fixture (<stateRoot>/runs/<slug>/{manifest.md,
// deliverables/*.md} in the exact conventions.md file shapes, plus
// <stateRoot>/repos/<name>/config.json) and spawn helpers that run the REAL
// scripts with an isolated HOME and a controlled STRAPPED_STATE_ROOT, so the
// user's real ~/.claude/strapped.json can never leak in.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const STATE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/state.mjs', import.meta.url)
)
export const ENSURE_WORKTREE_SCRIPT = fileURLToPath(
  new URL('../../plugins/strapped/scripts/ensure-worktree.sh', import.meta.url)
)

/** Full canonical deliverable frontmatter (values as raw frontmatter strings). */
export function deliverableFrontmatter(id, overrides = {}) {
  return {
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
    ...overrides,
  }
}

export function makeStateEnv() {
  const base = mkdtempSync(join(tmpdir(), 'strapped-state-'))
  const home = join(base, 'home')
  const stateRoot = join(base, 'state')
  mkdirSync(home)
  mkdirSync(stateRoot)

  const runDir = slug => join(stateRoot, 'runs', slug)

  /** Write a conventions-shaped manifest.md (nested budgets map, inline-flow repos/deliverables lists). */
  const writeManifest = (
    slug,
    {
      stateRoot: rootOverride,
      status = 'approved',
      seed = 42,
      budgets = { plan_rounds: 3, code_rounds: 3, confidence_min: 70 },
      repos = [],
      deliverables = [],
    } = {}
  ) => {
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

  const addDeliverable = (slug, filename, frontmatter, body = 'Body.') => {
    const dir = join(runDir(slug), 'deliverables')
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`)
    const file = join(dir, filename)
    writeFileSync(file, `---\n${lines.join('\n')}\n---\n${body}\n`)
    return file
  }

  const addRepoConfig = (name, config) => {
    const dir = join(stateRoot, 'repos', name)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(config, null, 2))
    return file
  }

  /** Build a whole run from [{id, deps, status, ...frontmatter overrides}] specs; returns the run dir. */
  const writeRun = (slug, specs, manifestOpts = {}) => {
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

  /** Spawn the real state.mjs with isolated HOME + STRAPPED_STATE_ROOT. */
  const runState = (args, { env = {} } = {}) =>
    spawnSync(process.execPath, [STATE_SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: process.env.PATH,
        STRAPPED_STATE_ROOT: stateRoot,
        ...env,
      },
    })

  const readFile = file => readFileSync(file, 'utf8')

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
export function makeGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'strapped-repo-'))
  const git = (...args) => {
    const res = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    return res
  }
  git('init', '--quiet', '-b', 'main', dir)
  writeFileSync(join(dir, 'README.md'), 'seed\n')
  git('-C', dir, 'add', '.')
  git('-C', dir, 'commit', '--quiet', '-m', 'init')
  return { dir, git: (...args) => git('-C', dir, ...args) }
}

/** Spawn the real ensure-worktree.sh (missing trailing args are simply not passed). */
export function runEnsureWorktree(...args) {
  return spawnSync('bash', [ENSURE_WORKTREE_SCRIPT, ...args.filter(a => a !== undefined)], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  })
}
