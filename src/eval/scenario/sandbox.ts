// Scenario sandbox builder/teardown. Everything a scenario touches — fixture
// repos, worktrees, the strapped state root, the source plan — lives under one
// mkdtemp root, so teardown is a single recursive rm and no global git state
// leaks. The state root is git-initialized with a seed commit because
// production state roots are git-backed and `state.mjs`'s transition
// auto-commit cadence SILENTLY SKIPS when the state root has no `.git`;
// without this, adherence checks over state-root commits could never pass.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Scenario, ScenarioSandbox, ScenarioSandboxRepo } from './types.ts'

/** Kebab-case a scenario id into the run slug. */
export function scenarioSlug(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Run `git -C <cwd> <args>`; throws with stderr on any failure (build-time determinism). */
function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (res.error) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.error.message}`)
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr.trim()}`)
  return res.stdout
}

/** Local identity + stage + commit; skips the commit when nothing is staged. */
function commitAll(repoRoot: string, message: string): void {
  git(repoRoot, 'config', 'user.name', 'strapped-eval')
  git(repoRoot, 'config', 'user.email', 'eval@localhost')
  git(repoRoot, 'add', '-A')
  // `git diff --cached --quiet` exits 0 when nothing is staged.
  const staged = spawnSync('git', ['-C', repoRoot, 'diff', '--cached', '--quiet'], { encoding: 'utf8' })
  if (staged.status !== 0) git(repoRoot, 'commit', '-q', '-m', message)
}

/**
 * Substitute sandbox-path tokens — `{{sandboxRoot}}`, `{{stateRoot}}`,
 * `{{repoRoot:<name>}}`, `{{configPath:<name>}}` — with the mkdtemp-derived
 * absolute paths. Every materialized file content passes through this: e.g. a
 * seeded manifest's `repos:` map must carry the sandbox repo's ABSOLUTE
 * root/config paths, which are unknowable in a static literal. Unknown tokens
 * throw at build time.
 */
function interpolate(content: string, tokens: ReadonlyMap<string, string>, where: string): string {
  return content.replace(/\{\{([^{}]+)\}\}/g, (_match, name: string) => {
    const value = tokens.get(name)
    if (value === undefined) throw new Error(`unknown sandbox token {{${name}}} in ${where}`)
    return value
  })
}

/** Write a file, creating parent directories. */
function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/**
 * Build a scenario's sandbox: per repo, copy the optional `snapshotPath` tree,
 * materialize the declarative `files` map (as an overlay when both), ensure a
 * committed git repo (`git init -b main` only when no `.git` came with the
 * snapshot) with local identity; scaffold and GIT-INIT the state root with
 * per-repo config.json and the runDir skeleton; write the ask as the source
 * plan; apply `seedRunState.files` into the runDir. All materialized contents
 * pass through sandbox-token interpolation. On any failure the partial tree is
 * removed before the error propagates.
 */
export function buildSandbox(scenario: Scenario): ScenarioSandbox {
  for (const repo of scenario.repos) {
    if (repo.files === undefined && repo.snapshotPath === undefined) {
      throw new Error(`scenario "${scenario.id}" repo "${repo.name}" declares neither files nor snapshotPath`)
    }
  }

  const slug = scenarioSlug(scenario.id)
  const root = mkdtempSync(join(tmpdir(), `strapped-scenario-${slug}-`))
  try {
    const stateRoot = join(root, 'state')
    const runDir = join(stateRoot, 'runs', slug)
    const sourcePlan = join(root, 'plans', `${slug}.md`)

    const repos: ScenarioSandboxRepo[] = scenario.repos.map(repo => ({
      name: repo.name,
      root: join(root, 'repos', repo.name),
      configPath: join(stateRoot, 'repos', repo.name, 'config.json'),
      worktreeRoot: join(root, 'worktrees', `${repo.name}__worktrees`),
    }))

    const tokens = new Map<string, string>([
      ['sandboxRoot', root],
      ['stateRoot', stateRoot],
    ])
    for (const repo of repos) {
      tokens.set(`repoRoot:${repo.name}`, repo.root)
      tokens.set(`configPath:${repo.name}`, repo.configPath)
    }

    // Fixture repos: snapshot copy first, declarative files as overlay, then
    // git init (only when the snapshot shipped no .git) + identity + commit.
    for (const [i, repo] of scenario.repos.entries()) {
      const paths = repos[i]
      if (paths === undefined) continue
      mkdirSync(paths.root, { recursive: true })
      if (repo.snapshotPath !== undefined) {
        cpSync(repo.snapshotPath, paths.root, { recursive: true })
      }
      for (const [rel, content] of Object.entries(repo.files ?? {})) {
        writeFile(join(paths.root, rel), interpolate(content, tokens, `repo ${repo.name} file ${rel}`))
      }
      if (!existsSync(join(paths.root, '.git'))) git(paths.root, 'init', '-q', '-b', 'main')
      commitAll(paths.root, 'scenario: fixture repo')
      mkdirSync(paths.worktreeRoot, { recursive: true })
    }

    // State root scaffold: per-repo config.json + the runDir skeleton.
    for (const [i, repo] of scenario.repos.entries()) {
      const paths = repos[i]
      if (paths === undefined) continue
      writeFile(
        paths.configPath,
        JSON.stringify({ validations: repo.validations, worktreeRoot: paths.worktreeRoot, provisioning: '' }, null, 2) + '\n'
      )
    }
    for (const sub of ['deliverables', 'reviews', 'critiques']) {
      mkdirSync(join(runDir, sub), { recursive: true })
      // git tracks files, not directories — the marker keeps the scaffold (and
      // therefore a non-empty seed commit) present in the state root's history.
      writeFileSync(join(runDir, sub, '.gitkeep'), '')
    }

    writeFile(sourcePlan, interpolate(scenario.ask, tokens, 'scenario ask'))

    for (const [rel, content] of Object.entries(scenario.seedRunState?.files ?? {})) {
      writeFile(join(runDir, rel), interpolate(content, tokens, `seedRunState file ${rel}`))
    }

    // Git-init the state root with one seed commit: `state.mjs`'s transition
    // auto-commit runs ONLY when `.git` already exists, so a scenario's
    // stage-scoped run would otherwise never produce state-root commits.
    git(stateRoot, 'init', '-q', '-b', 'main')
    commitAll(stateRoot, 'scenario: seed state root')
    const stateSeedCommit = git(stateRoot, 'rev-parse', 'HEAD').trim()

    return { root, slug, stateRoot, runDir, sourcePlan, repos, stateSeedCommit }
  } catch (err) {
    rmSync(root, { recursive: true, force: true })
    throw err
  }
}

/**
 * Delete the whole sandbox tree. Worktrees registered by `git worktree` live
 * inside the sandbox too, so removing the tree prunes everything — no global
 * git state survives.
 */
export function removeSandbox(sandbox: ScenarioSandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true })
}
