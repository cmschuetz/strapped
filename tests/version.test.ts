// Integration tests for tools/version.ts: the pure semver helpers, plus the
// real CLI spawned under bun (process.execPath is bun under `bun test`; version.ts
// is a dev-time bun tool, not a shipped node deployable) against temp plugin.json
// copies and a throwaway git repo for the `check` guard. Real binaries, no mocks.

import assert from 'node:assert/strict'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import {
  bumpSemver,
  compareSemver,
  generatedArtifacts,
  parseSemver,
  formatSemver,
} from '../tools/version.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TOOL = join(ROOT, 'tools', 'version.ts')

function runVersion(args: string[], cwd: string = ROOT): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8' })
}

const PLUGIN_JSON =
  JSON.stringify({ name: 'strapped', version: '1.2.3', description: 'x' }, null, 2) + '\n'

function tempRepoRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// --- pure helpers ------------------------------------------------------------

test('parseSemver accepts MAJOR.MINOR.PATCH and rejects everything else', () => {
  assert.deepEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 })
  assert.deepEqual(parseSemver('0.0.0'), { major: 0, minor: 0, patch: 0 })
  for (const bad of ['1.2', 'v1.2.3', '1.2.3-rc', 'a.b.c', '1.2.3.4', '']) {
    const res = spawnSync(process.execPath, ['-e', `import('${TOOL}').then(m => m.parseSemver(${JSON.stringify(bad)}))`], {
      encoding: 'utf8',
    })
    assert.equal(res.status, 1, `parseSemver("${bad}") should have died`)
    assert.match(res.stderr, /not a valid MAJOR\.MINOR\.PATCH/)
  }
})

test('bumpSemver applies standard reset semantics', () => {
  const base = { major: 1, minor: 2, patch: 3 }
  assert.equal(formatSemver(bumpSemver('patch', base)), '1.2.4')
  assert.equal(formatSemver(bumpSemver('minor', base)), '1.3.0')
  assert.equal(formatSemver(bumpSemver('major', base)), '2.0.0')
  // Carry across a two-digit component.
  const nines = parseSemver('1.9.9')
  const minor = bumpSemver('minor', nines)
  assert.equal(formatSemver(minor), '1.10.0')
  assert.equal(formatSemver(bumpSemver('major', minor)), '2.0.0')
})

test('compareSemver orders across every component', () => {
  assert.equal(compareSemver(parseSemver('1.0.0'), parseSemver('2.0.0')), -1)
  assert.equal(compareSemver(parseSemver('1.2.0'), parseSemver('1.1.0')), 1)
  assert.equal(compareSemver(parseSemver('1.1.1'), parseSemver('1.1.2')), -1)
  assert.equal(compareSemver(parseSemver('1.1.1'), parseSemver('1.1.1')), 0)
  // Higher minor beats higher patch.
  assert.equal(compareSemver(parseSemver('1.2.0'), parseSemver('1.1.9')), 1)
})

// --- read CLI ----------------------------------------------------------------

test('read prints {version, major, minor, patch} from the committed plugin.json', () => {
  const res = runVersion(['read'])
  assert.equal(res.status, 0, res.stderr)
  const json = JSON.parse(res.stdout) as Record<string, unknown>
  assert.equal(typeof json.version, 'string')
  const sv = parseSemver(String(json.version))
  assert.deepEqual(json, { version: formatSemver(sv), major: sv.major, minor: sv.minor, patch: sv.patch })
})

// --- bump CLI ----------------------------------------------------------------

test('bump minor rewrites a temp plugin.json to the exact expected bytes, prints {old,new}, one-line diff', () => {
  // STRAPPED_PLUGIN_JSON points the CLI at a temp copy so the real file is never
  // clobbered — the test seam the design calls for.
  const dir = tempRepoRoot('strapped-version-bump-')
  const pluginPath = join(dir, 'plugin.json')
  writeFileSync(pluginPath, PLUGIN_JSON)

  const res = spawnSync(process.execPath, [TOOL, 'bump', 'minor'], {
    encoding: 'utf8',
    env: { ...process.env, STRAPPED_PLUGIN_JSON: pluginPath },
  })
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), { old: '1.2.3', new: '1.3.0' })

  const after = readFileSync(pluginPath, 'utf8')
  const expected = JSON.stringify({ name: 'strapped', version: '1.3.0', description: 'x' }, null, 2) + '\n'
  assert.equal(after, expected)
  // Only the version line differs from the original (indent + trailing newline preserved).
  const before = PLUGIN_JSON.split('\n')
  const changed = after.split('\n').filter((line, i) => line !== before[i])
  assert.deepEqual(changed, ['  "version": "1.3.0",'])
})

test('bump patch and major on a temp copy apply the right reset semantics', () => {
  for (const [level, expected] of [
    ['patch', '1.2.4'],
    ['major', '2.0.0'],
  ] as const) {
    const dir = tempRepoRoot('strapped-version-bump-')
    const pluginPath = join(dir, 'plugin.json')
    writeFileSync(pluginPath, PLUGIN_JSON)
    const res = spawnSync(process.execPath, [TOOL, 'bump', level], {
      encoding: 'utf8',
      env: { ...process.env, STRAPPED_PLUGIN_JSON: pluginPath },
    })
    assert.equal(res.status, 0, res.stderr)
    assert.deepEqual(JSON.parse(res.stdout), { old: '1.2.3', new: expected })
  }
})

test('bump with an invalid/absent level exits 1 with usage', () => {
  for (const args of [['bump'], ['bump', 'huge'], ['bump', 'MAJOR']]) {
    const res = runVersion(args)
    assert.equal(res.status, 1, `${args.join(' ')} should exit 1`)
    assert.match(res.stderr, /bump <major\|minor\|patch>/)
  }
})

test('unknown/absent subcommand exits 1 with usage', () => {
  for (const args of [[], ['frobnicate']]) {
    const res = runVersion(args)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /usage: version\.ts/)
  }
})

// --- check guard (throwaway git repo) ----------------------------------------

function git(cwd: string, ...args: string[]): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

/**
 * Build a throwaway git repo committed as the base: plugin.json at the semver
 * path + a fake file at every generated-artifact outfile. Returns the repo dir.
 */
function seedRepo(version: string): { dir: string; artifacts: string[] } {
  const dir = tempRepoRoot('strapped-version-check-')
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')

  const pluginPath = join(dir, 'plugins', 'strapped', '.claude-plugin', 'plugin.json')
  mkdirSync(dirname(pluginPath), { recursive: true })
  writeFileSync(pluginPath, JSON.stringify({ name: 'strapped', version }, null, 2) + '\n')

  const artifacts = generatedArtifacts()
  for (const rel of artifacts) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, `// base content for ${rel}\n`)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return { dir, artifacts }
}

test('check fails (exit 1, names the artifact) when a generated artifact changed without a bump', () => {
  const { dir, artifacts } = seedRepo('1.0.0')
  const target = artifacts[0]
  assert.ok(target)
  writeFileSync(join(dir, target), `// MUTATED ${target}\n`)

  const res = runVersion(['check', '--base', 'HEAD'], dir)
  assert.equal(res.status, 1, res.stdout)
  assert.match(res.stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(res.stderr, /bun tools\/version\.ts bump/)
})

test('check passes (exit 0) when the same artifact change is accompanied by a version bump', () => {
  const { dir, artifacts } = seedRepo('1.0.0')
  const target = artifacts[0]
  assert.ok(target)
  writeFileSync(join(dir, target), `// MUTATED ${target}\n`)
  // Bump the working-tree version above the base.
  const pluginPath = join(dir, 'plugins', 'strapped', '.claude-plugin', 'plugin.json')
  writeFileSync(pluginPath, JSON.stringify({ name: 'strapped', version: '1.1.0' }, null, 2) + '\n')

  const res = runVersion(['check', '--base', 'HEAD'], dir)
  assert.equal(res.status, 0, res.stderr)
  const json = JSON.parse(res.stdout) as { changed: string[]; bumped: boolean; base: string }
  assert.ok(json.changed.includes(target))
  assert.equal(json.bumped, true)
})

test('check passes (exit 0) when no generated artifact changed', () => {
  const { dir } = seedRepo('1.0.0')
  const res = runVersion(['check', '--base', 'HEAD'], dir)
  assert.equal(res.status, 0, res.stderr)
  const json = JSON.parse(res.stdout) as { changed: string[]; bumped: boolean }
  assert.deepEqual(json.changed, [])
})

test('check skips gracefully (exit 0, stderr note) when the base ref is unresolvable', () => {
  const { dir } = seedRepo('1.0.0')
  const res = runVersion(['check', '--base', 'no-such-ref'], dir)
  assert.equal(res.status, 0, res.stderr)
  assert.equal(res.stdout, '')
  assert.match(res.stderr, /unresolvable — skipping version guard/)
})
