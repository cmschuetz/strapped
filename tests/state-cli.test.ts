// Integration tests for plugins/strapped/scripts/state.mjs: spawn the REAL
// CLI with an isolated HOME and a controlled STRAPPED_STATE_ROOT against temp
// state-root fixtures in the exact conventions.md file shapes.

import assert from 'node:assert/strict'
import { type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import matter from 'gray-matter'
import { deliverableFrontmatter, makeStateEnv } from './helpers/state-env.ts'

interface RepoJson {
  name: string | null
  root: string | null
  config: string
  configExists: boolean
  validations: string[] | null
  worktreeRoot: string | null
  provisioning: string | null
}

interface ResolveJson {
  slug: string
  stateRoot: string
  runRoot: string
  runDir: string
  manifest: string
  exists: boolean
  status: string | null
  seed: number | null
  budgets: Record<string, number> | null
  repos: RepoJson[]
}

interface DagNodeJson {
  id: string
  file: string
  title: string | null
  status: string
  deps: string[]
  repo: string | null
  branch: string | null
  base: string | null
  worktree: string | null
  pr: string | null
  review_rounds_used: number
  feedback_rounds_used: number
  parked_reason: string | null
  estimated_diff_lines: number | null
}

interface DagJson {
  manifest: { status: string | null; seed: number | null; budgets: Record<string, number> | null }
  nodes: DagNodeJson[]
  ready: string[]
  topo: string[]
  blocked: { id: string; blockedOn: string[] }[]
  remaining: number
}

const parse = <T = unknown>(res: SpawnSyncReturns<string>): T => JSON.parse(res.stdout) as T

// --- resolve -----------------------------------------------------------------

test('resolve: env stateRoot + existing manifest → exists true, repos map with config values', () => {
  const env = makeStateEnv()
  env.writeManifest('my-run', {
    status: 'approved',
    seed: 7,
    repos: [{ name: 'repo-a', root: '/abs/repo-a' }],
    deliverables: [{ id: 'D1', file: 'deliverables/D1-x.md', deps: [] }],
  })
  env.addRepoConfig('repo-a', {
    validations: ['npm test'],
    worktreeRoot: '/abs/repo-a__worktrees',
    provisioning: 'copy .env.example to .env',
  })
  const res = env.runState(['resolve', 'my-run'])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<ResolveJson>(res)
  assert.equal(json.exists, true)
  assert.equal(json.slug, 'my-run')
  assert.equal(json.stateRoot, env.stateRoot)
  assert.equal(json.runRoot, join(env.stateRoot, 'runs'))
  assert.equal(json.runDir, env.runDir('my-run'))
  assert.equal(json.manifest, join(env.runDir('my-run'), 'manifest.md'))
  assert.equal(json.status, 'approved')
  assert.equal(json.seed, 7)
  assert.deepEqual(json.budgets, { plan_rounds: 3, code_rounds: 3, confidence_min: 70 })
  assert.deepEqual(json.repos, [
    {
      name: 'repo-a',
      root: '/abs/repo-a',
      config: join(env.stateRoot, 'repos', 'repo-a', 'config.json'),
      configExists: true,
      validations: ['npm test'],
      worktreeRoot: '/abs/repo-a__worktrees',
      provisioning: 'copy .env.example to .env',
    },
  ])
})

test('resolve: anchor-file stateRoot with ~ prefix expands against isolated HOME', () => {
  const env = makeStateEnv()
  mkdirSync(join(env.home, '.claude'), { recursive: true })
  writeFileSync(join(env.home, '.claude', 'strapped.json'), JSON.stringify({ stateRoot: '~/nested/state' }))
  const expanded = join(env.home, 'nested', 'state')
  env.writeManifest('my-run', {
    stateRoot: expanded,
    repos: [{ name: 'repo-a', root: '/abs/repo-a', config: join(expanded, 'repos', 'repo-a', 'config.json') }],
    deliverables: [{ id: 'D1', file: 'deliverables/D1-x.md', deps: [] }],
  })
  const res = env.runState(['resolve', 'my-run'], { env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0, res.stderr)
  const json = parse<ResolveJson>(res)
  assert.equal(json.stateRoot, expanded)
  assert.equal(json.exists, true)
})

test('resolve: missing manifest → exists false, exit 0', () => {
  const env = makeStateEnv()
  const res = env.runState(['resolve', 'no-such-run'])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<ResolveJson>(res)
  assert.equal(json.exists, false)
  assert.equal(json.runDir, env.runDir('no-such-run'))
  assert.deepEqual(json.repos, [])
})

test('resolve: no env, no anchor → default ~/.claude/strapped under isolated HOME', () => {
  const env = makeStateEnv()
  const res = env.runState(['resolve', 'my-run'], { env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(parse<ResolveJson>(res).stateRoot, join(env.home, '.claude', 'strapped'))
})

test('resolve: relative stateRoot (env or anchor) → exit 1 with one-line stderr', () => {
  const env = makeStateEnv()
  const viaEnv = env.runState(['resolve', 'my-run'], { env: { STRAPPED_STATE_ROOT: 'plans/strapped' } })
  assert.equal(viaEnv.status, 1)
  assert.equal(viaEnv.stdout, '')
  assert.match(viaEnv.stderr, /not absolute/)
  assert.equal(viaEnv.stderr.trim().split('\n').length, 1)

  mkdirSync(join(env.home, '.claude'), { recursive: true })
  writeFileSync(join(env.home, '.claude', 'strapped.json'), JSON.stringify({ stateRoot: 'plans/strapped' }))
  const viaAnchor = env.runState(['resolve', 'my-run'], { env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(viaAnchor.status, 1)
  assert.equal(viaAnchor.stdout, '')
  assert.match(viaAnchor.stderr, /not absolute/)
  assert.equal(viaAnchor.stderr.trim().split('\n').length, 1)
})

test('resolve: repo config missing → configExists false, exit 0', () => {
  const env = makeStateEnv()
  env.writeManifest('my-run', {
    repos: [{ name: 'repo-a', root: '/abs/repo-a' }],
    deliverables: [{ id: 'D1', file: 'deliverables/D1-x.md', deps: [] }],
  })
  const res = env.runState(['resolve', 'my-run'])
  assert.equal(res.status, 0, res.stderr)
  const [repo] = parse<ResolveJson>(res).repos
  assert.ok(repo)
  assert.equal(repo.configExists, false)
  assert.equal(repo.validations, null)
  assert.equal(repo.worktreeRoot, null)
})

test('resolve: missing slug argument → usage on stderr, exit 1', () => {
  const env = makeStateEnv()
  const res = env.runState(['resolve'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /usage/)
})

// --- dag -----------------------------------------------------------------

test('dag: roots ready, child blocked until parent done/pr-open/merged', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [
    { id: 'D1', status: 'pending' },
    { id: 'D2', deps: ['D1'], status: 'pending' },
    { id: 'D3', status: 'done' },
    { id: 'D4', deps: ['D3'], status: 'pending' },
  ])
  const res = env.runState(['dag', dir])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<DagJson>(res)
  assert.deepEqual(json.ready, ['D1', 'D4'])
  assert.deepEqual(json.blocked, [{ id: 'D2', blockedOn: ['D1'] }])
  assert.deepEqual(json.topo, ['D1', 'D2', 'D3', 'D4'])
  assert.ok(json.topo.indexOf('D1') < json.topo.indexOf('D2'))
  assert.ok(json.topo.indexOf('D3') < json.topo.indexOf('D4'))
  assert.equal(json.remaining, 3)
  assert.equal(json.manifest.status, 'approved')
  const d2 = json.nodes.find(n => n.id === 'D2')
  assert.ok(d2)
  assert.deepEqual(d2.deps, ['D1'])
  assert.equal(d2.status, 'pending')
  assert.equal(d2.repo, 'repo-a')
  assert.equal(d2.review_rounds_used, 0)
})

test('dag: remaining counts pr-open/merged nodes as complete (partially-shipped run → remaining excludes them)', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [
    { id: 'D1', status: 'merged' },
    { id: 'D2', status: 'pr-open' },
    { id: 'D3', status: 'done' },
    { id: 'D4', deps: ['D1', 'D2', 'D3'], status: 'pending' },
  ])
  const res = env.runState(['dag', dir])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<DagJson>(res)
  assert.equal(json.remaining, 1)
  assert.deepEqual(json.ready, ['D4'])
  assert.deepEqual(json.blocked, [])
})

test('dag: --only readmits a parked node', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [
    { id: 'D1', status: 'done' },
    { id: 'D2', deps: ['D1'], status: 'parked', parked_reason: 'validation failure' },
    { id: 'D3', status: 'pending' },
  ])
  const res = env.runState(['dag', dir, '--only', 'D2'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(parse<DagJson>(res).ready, ['D2'])
})

test('dag: --only readmits an in-progress node', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [
    { id: 'D1', status: 'done' },
    { id: 'D2', deps: ['D1'], status: 'in-progress' },
    { id: 'D3', status: 'pending' },
  ])
  const res = env.runState(['dag', dir, '--only', 'D2'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(parse<DagJson>(res).ready, ['D2'])
})

test('dag: unknown dep / cycle → exit 1 naming the offender', () => {
  const env = makeStateEnv()
  const unknownDir = env.writeRun('unknown-dep', [
    { id: 'D1', status: 'pending' },
    { id: 'D2', deps: ['D9'], status: 'pending' },
  ])
  const unknown = env.runState(['dag', unknownDir])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown dep D9/)
  assert.match(unknown.stderr, /D2/)

  const cycleDir = env.writeRun('cycle', [
    { id: 'D1', deps: ['D2'], status: 'pending' },
    { id: 'D2', deps: ['D1'], status: 'pending' },
  ])
  const cycle = env.runState(['dag', cycleDir])
  assert.equal(cycle.status, 1)
  assert.match(cycle.stderr, /cycle/)
  assert.match(cycle.stderr, /D1, D2/)
})

// --- set -----------------------------------------------------------------

test('set: single line changed, rest byte-identical; unknown field → exit 1', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'done' }))
  const before = env.readFile(file)
  const res = env.runState(['set', file, 'pr', 'https://github.com/o/r/pull/9'])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(parse(res), { file, field: 'pr', old: 'null', new: 'https://github.com/o/r/pull/9' })
  const beforeLines = before.split('\n')
  const afterLines = env.readFile(file).split('\n')
  assert.equal(afterLines.length, beforeLines.length)
  const changed = beforeLines.filter((line, i) => line !== afterLines[i])
  assert.deepEqual(changed, ['pr: null'])
  // js-yaml leaves the pr: URL unquoted (its :// is colon-slash, a valid plain
  // scalar); it quotes only colon-SPACE values like parked_reason. The
  // grep-consumed shape is the single-space `pr: ` line, which survives.
  assert.ok(
    afterLines.some(l => l.startsWith('pr: ') && l.includes('https://github.com/o/r/pull/9')),
    afterLines.join('\n')
  )

  const unknown = env.runState(['set', file, 'no_such_field', 'x'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown frontmatter field "no_such_field"/)
  assert.equal(env.readFile(file), afterLines.join('\n'))
})

test('set: untouched fields survive semantically and every grep-consumed shape holds after a write', () => {
  const env = makeStateEnv()
  // The writer is gray-matter now, so the guarantee is semantic — untouched
  // fields parse to identical values — plus survival of the two grep-consumed
  // shapes (the `deps: [...]` flow array and single-space `key: value` lines),
  // NOT byte-for-byte preservation of irregular input spacing.
  const dir = join(env.runDir('my-run'), 'deliverables')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'D9-x.md')
  const original =
    [
      '---',
      'id: D9',
      'title: Deliverable D9',
      'deps: [D1, D2]',
      'status: pending',
      'pr: null',
      'parked_reason: null',
      '---',
      '# Body',
    ].join('\n') + '\n'
  writeFileSync(file, original)

  const res = env.runState(['set', file, 'status', 'in-progress'])
  assert.equal(res.status, 0, res.stderr)
  const after = env.readFile(file)

  // (i) grep-consumed shapes survive: the deps flow array (condenseFlow drops
  // inner spaces) and single-space scalar lines sync-prs.sh/preamble.sh read.
  assert.match(after, /^status: in-progress$/m)
  assert.match(after, /^id: D9$/m)
  assert.match(after, /^pr: null$/m)
  assert.match(after, /^deps: \[D1,D2\]$/m)

  // (ii) every untouched field parses to an identical value.
  const before = matter(original).data
  const now = matter(after).data
  for (const key of ['id', 'title', 'deps', 'pr', 'parked_reason']) {
    assert.deepEqual(now[key], before[key], `${key} must survive the write`)
  }
  assert.equal(now.status, 'in-progress')
})

test('set: newline-bearing value → exit 1, file untouched (no frontmatter line injection)', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'done' }))
  const before = env.readFile(file)
  for (const value of ['line1\nstatus: merged', 'line1\rstatus: merged']) {
    const res = env.runState(['set', file, 'parked_reason', value])
    assert.equal(res.status, 1)
    assert.equal(res.stderr.trim(), 'state.mjs: value must be a single line')
    assert.equal(res.stderr.trim().split('\n').length, 1)
    assert.equal(env.readFile(file), before)
  }
  const statusLines = env.readFile(file).split('\n').filter(l => l.startsWith('status:'))
  assert.deepEqual(statusLines, ['status: done'])
})

test('set: colon-bearing free-text value round-trips as the exact string (not a nested map)', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'parked' }))
  const reason = 'typecheck failed: TS2322'
  const res = env.runState(['set', file, 'parked_reason', reason])
  assert.equal(res.status, 0, res.stderr)
  assert.deepEqual(parse(res), { file, field: 'parked_reason', old: 'null', new: reason })
  // The field must re-parse to the literal string, NOT a YAML mapping.
  const now = matter(env.readFile(file)).data
  assert.equal(now.parked_reason, reason)
  assert.equal(typeof now.parked_reason, 'string')
})

// --- transition ------------------------------------------------------------

test('transition: skip-edges pending→in-progress, in-progress→done, in-progress→parked, parked→in-progress each accepted', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1'))
  const edges: [string, string][] = [
    ['in-progress', 'pending'],
    ['parked', 'in-progress'],
    ['in-progress', 'parked'],
    ['done', 'in-progress'],
  ]
  for (const [to, from] of edges) {
    const res = env.runState(['transition', file, to, '--from', from])
    assert.equal(res.status, 0, `${from} → ${to}: ${res.stderr}`)
    assert.deepEqual(parse(res), { file, from, to, changed: true })
    assert.match(env.readFile(file), new RegExp(`^status: ${to}$`, 'm'))
  }
})

test('transition: virtual-status edges pending→ready and in-progress→implemented rejected, exit 1, file untouched', () => {
  const env = makeStateEnv()
  const pendingFile = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'pending' }))
  const pendingBefore = env.readFile(pendingFile)
  const toReady = env.runState(['transition', pendingFile, 'ready'])
  assert.equal(toReady.status, 1)
  assert.match(toReady.stderr, /illegal transition pending → ready/)
  assert.equal(env.readFile(pendingFile), pendingBefore)

  const wipFile = env.addDeliverable('my-run', 'D2-x.md', deliverableFrontmatter('D2', { status: 'in-progress' }))
  const wipBefore = env.readFile(wipFile)
  const toImplemented = env.runState(['transition', wipFile, 'implemented'])
  assert.equal(toImplemented.status, 1)
  assert.match(toImplemented.stderr, /illegal transition in-progress → implemented/)
  assert.equal(env.readFile(wipFile), wipBefore)
})

test('transition: feedback re-entry pr-open→fixing accepted; illegal edge exit 1 leaves file untouched; no-op returns changed false', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'pr-open' }))
  const reentry = env.runState(['transition', file, 'fixing'])
  assert.equal(reentry.status, 0, reentry.stderr)
  assert.deepEqual(parse(reentry), { file, from: 'pr-open', to: 'fixing', changed: true })

  const before = env.readFile(file)
  const illegal = env.runState(['transition', file, 'pending'])
  assert.equal(illegal.status, 1)
  assert.match(illegal.stderr, /illegal transition fixing → pending/)
  assert.equal(env.readFile(file), before)

  const noop = env.runState(['transition', file, 'fixing'])
  assert.equal(noop.status, 0, noop.stderr)
  assert.deepEqual(parse(noop), { file, from: 'fixing', to: 'fixing', changed: false })
  assert.equal(env.readFile(file), before)
})

test('transition: pr --update rebase-conflict park edges pr-open→parked and done→parked accepted', () => {
  const env = makeStateEnv()
  const cases: [string, string][] = [
    ['D1', 'pr-open'],
    ['D2', 'done'],
  ]
  for (const [id, from] of cases) {
    const file = env.addDeliverable('my-run', `${id}-x.md`, deliverableFrontmatter(id, { status: from }))
    const res = env.runState(['transition', file, 'parked', '--from', from])
    assert.equal(res.status, 0, `${from} → parked: ${res.stderr}`)
    assert.deepEqual(parse(res), { file, from, to: 'parked', changed: true })
    assert.match(env.readFile(file), /^status: parked$/m)
  }
})

test('transition: --from mismatch → exit 1, no write', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'pending' }))
  const before = env.readFile(file)
  const res = env.runState(['transition', file, 'in-progress', '--from', 'parked'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /expected status "parked" but found "pending"/)
  assert.equal(env.readFile(file), before)
})

// --- manifest-status ---------------------------------------------------------

test('manifest-status: forward flip approved→implementing; same-status no-op returns changed false, exit 0; backward flip exit 1', () => {
  const env = makeStateEnv()
  env.writeManifest('my-run', {
    status: 'approved',
    repos: [{ name: 'repo-a', root: '/abs/repo-a' }],
    deliverables: [{ id: 'D1', file: 'deliverables/D1-x.md', deps: [] }],
  })
  const dir = env.runDir('my-run')
  const file = join(dir, 'manifest.md')

  const forward = env.runState(['manifest-status', dir, 'implementing'])
  assert.equal(forward.status, 0, forward.stderr)
  assert.deepEqual(parse(forward), { file, from: 'approved', to: 'implementing', changed: true })
  assert.match(env.readFile(file), /^status: implementing$/m)

  const noop = env.runState(['manifest-status', dir, 'implementing'])
  assert.equal(noop.status, 0, noop.stderr)
  assert.deepEqual(parse(noop), { file, from: 'implementing', to: 'implementing', changed: false })

  const before = env.readFile(file)
  const backward = env.runState(['manifest-status', dir, 'draft'])
  assert.equal(backward.status, 1)
  assert.match(backward.stderr, /forward-only/)
  assert.equal(env.readFile(file), before)
})

// --- sync-prs.sh grep compatibility -------------------------------------------

test('transition + sync-prs grep compatibility: flipped file still matches ^status: <v>$', () => {
  const env = makeStateEnv()
  const file = env.addDeliverable('my-run', 'D1-x.md', deliverableFrontmatter('D1', { status: 'done' }))
  const res = env.runState(['transition', file, 'pr-open'])
  assert.equal(res.status, 0, res.stderr)
  const src = env.readFile(file)
  assert.match(src, /^status: pr-open$/m)
  assert.doesNotMatch(src, /^status: done$/m)
  assert.match(src, /^id: D1$/m)
  assert.match(src, /^deps: \[\]$/m)
  assert.match(src, /^pr: null$/m)
})
