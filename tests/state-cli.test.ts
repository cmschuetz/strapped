// Integration tests for plugins/strapped/scripts/state.mjs: spawn the REAL
// CLI with an isolated HOME and a controlled STRAPPED_STATE_ROOT against temp
// state-root fixtures in the exact conventions.md file shapes.

import assert from 'node:assert/strict'
import { type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import yaml from 'js-yaml'
import { deliverableFrontmatter, makeStateEnv } from './helpers/state-env.ts'

// Read a frontmatter data block the same way the CLI does (js-yaml), for the
// semantic-equality assertions on written output below.
function fmData(src: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src)
  return m ? ((yaml.load(m[1] ?? '') ?? {}) as Record<string, unknown>) : {}
}

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

// --- runroot -----------------------------------------------------------------

interface RunRootJson {
  stateRoot: string
  runRoot: string
}

test('runroot: env stateRoot → { stateRoot, runRoot } with no slug, exit 0', () => {
  const env = makeStateEnv()
  const res = env.runState(['runroot'])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<RunRootJson>(res)
  assert.equal(json.stateRoot, env.stateRoot)
  assert.equal(json.runRoot, join(env.stateRoot, 'runs'))
})

test('runroot: no env, no anchor → default ~/.claude/strapped under isolated HOME', () => {
  const env = makeStateEnv()
  const res = env.runState(['runroot'], { env: { STRAPPED_STATE_ROOT: undefined } })
  assert.equal(res.status, 0, res.stderr)
  const json = parse<RunRootJson>(res)
  assert.equal(json.stateRoot, join(env.home, '.claude', 'strapped'))
  assert.equal(json.runRoot, join(env.home, '.claude', 'strapped', 'runs'))
})

test('runroot: relative stateRoot → exit 1 with one-line stderr, no silent fallback', () => {
  const env = makeStateEnv()
  const res = env.runState(['runroot'], { env: { STRAPPED_STATE_ROOT: 'plans/strapped' } })
  assert.equal(res.status, 1)
  assert.equal(res.stdout, '')
  assert.match(res.stderr, /not absolute/)
  assert.equal(res.stderr.trim().split('\n').length, 1)
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
  // The writer re-serializes via js-yaml now, so the guarantee is semantic — untouched
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
  const before = fmData(original)
  const now = fmData(after)
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
  const now = fmData(env.readFile(file))
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

// --- feedback-index ----------------------------------------------------------

interface IndexComment {
  externalId: string
  threadId: string | null
  deliverableId: string | null
  pr: string | null
  path: string | null
  line: number | null
  author: string | null
  body: string | null
  status: string
  commit: string | null
  githubResolved: boolean
  updated: string
}
interface ReadJson {
  path: string
  exists: boolean
  comments: IndexComment[]
}
interface UpsertJson {
  inserted: number
  updated: number
  resolvedFromGithub: number
  total: number
}
interface SetJson {
  externalId: string
  from: string
  to: string
  commit: string | null
  changed: boolean
}

/** Write a fetched-comments array to a scratch --from file and return its path. */
function writeFrom(dir: string, name: string, records: unknown[]): string {
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify(records))
  return file
}

test('feedback-index read: fresh run dir → exists false, comments empty, exit 0', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])
  const res = env.runState(['feedback-index', 'read', dir])
  assert.equal(res.status, 0, res.stderr)
  const json = parse<ReadJson>(res)
  assert.equal(json.exists, false)
  assert.deepEqual(json.comments, [])
  assert.equal(json.path, join(dir, 'feedback-index.json'))
})

test('feedback-index upsert: inserts as unaddressed, then an incoming githubResolved flips it to resolved and a new id inserts', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])

  const first = writeFrom(dir, 'fetch-1.json', [
    { externalId: '101', threadId: 'T101', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/a.ts', line: 5, author: 'octocat', body: 'fix a', githubResolved: false },
    { externalId: '102', threadId: 'T102', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/b.ts', line: 9, author: 'octocat', body: 'fix b', githubResolved: false },
  ])
  const r1 = env.runState(['feedback-index', 'upsert', dir, '--from', first])
  assert.equal(r1.status, 0, r1.stderr)
  assert.deepEqual(parse<UpsertJson>(r1), { inserted: 2, updated: 0, resolvedFromGithub: 0, total: 2 })

  const afterFirst = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  assert.deepEqual(afterFirst.comments.map(c => c.status), ['unaddressed', 'unaddressed'])
  const c101 = afterFirst.comments.find(c => c.externalId === '101')
  assert.ok(c101)
  assert.equal(c101.threadId, 'T101')
  assert.equal(c101.line, 5)
  assert.equal(c101.commit, null)

  // Second round: 101 comes back reviewer-self-resolved; 103 is brand new.
  const second = writeFrom(dir, 'fetch-2.json', [
    { externalId: '101', threadId: 'T101', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/a.ts', line: 5, author: 'octocat', body: 'fix a', githubResolved: true },
    { externalId: '103', threadId: 'T103', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/c.ts', line: 2, author: 'octocat', body: 'fix c', githubResolved: false },
  ])
  const r2 = env.runState(['feedback-index', 'upsert', dir, '--from', second])
  assert.equal(r2.status, 0, r2.stderr)
  assert.deepEqual(parse<UpsertJson>(r2), { inserted: 1, updated: 1, resolvedFromGithub: 1, total: 3 })

  const afterSecond = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  const byId = new Map(afterSecond.comments.map(c => [c.externalId, c]))
  assert.equal(byId.get('101')?.status, 'resolved')
  assert.equal(byId.get('101')?.githubResolved, true)
  assert.equal(byId.get('102')?.status, 'unaddressed')
  assert.equal(byId.get('103')?.status, 'unaddressed')
})

test('feedback-index upsert: review-body / global records (threadId null) insert as unaddressed and take a later set', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])
  const from = writeFrom(dir, 'fetch.json', [
    { externalId: 'review:55', threadId: null, deliverableId: 'D1', pr: 'https://gh/pr/1', path: null, line: null, author: 'octocat', body: 'overall: rework error paths', githubResolved: false },
    { externalId: 'issue:77', threadId: null, deliverableId: 'D1', pr: 'https://gh/pr/1', path: null, line: null, author: 'octocat', body: 'a global note', githubResolved: false },
  ])
  const r = env.runState(['feedback-index', 'upsert', dir, '--from', from])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(parse<UpsertJson>(r), { inserted: 2, updated: 0, resolvedFromGithub: 0, total: 2 })

  const read = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  const review = read.comments.find(c => c.externalId === 'review:55')
  assert.ok(review)
  assert.equal(review.threadId, null)
  assert.equal(review.status, 'unaddressed')

  const set = env.runState(['feedback-index', 'set', dir, 'review:55', 'addressed', '--commit', 'deadbeef'])
  assert.equal(set.status, 0, set.stderr)
  assert.deepEqual(parse<SetJson>(set), { externalId: 'review:55', from: 'unaddressed', to: 'addressed', commit: 'deadbeef', changed: true })

  const afterSet = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  const now = afterSet.comments.find(c => c.externalId === 'review:55')
  assert.equal(now?.status, 'addressed')
  assert.equal(now?.commit, 'deadbeef')
  assert.equal(now?.threadId, null)
})

test('feedback-index upsert: an ignored / not_needed comment is never reconciled to resolved by an incoming githubResolved', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])
  const seed = writeFrom(dir, 'seed.json', [
    { externalId: '201', threadId: 'T201', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/x.ts', line: 1, author: 'octocat', body: 'x', githubResolved: false },
    { externalId: '202', threadId: 'T202', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/y.ts', line: 2, author: 'octocat', body: 'y', githubResolved: false },
  ])
  env.runState(['feedback-index', 'upsert', dir, '--from', seed])
  env.runState(['feedback-index', 'set', dir, '201', 'ignored'])
  env.runState(['feedback-index', 'set', dir, '202', 'not_needed'])

  const resolved = writeFrom(dir, 'resolved.json', [
    { externalId: '201', threadId: 'T201', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/x.ts', line: 1, author: 'octocat', body: 'x', githubResolved: true },
    { externalId: '202', threadId: 'T202', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/y.ts', line: 2, author: 'octocat', body: 'y', githubResolved: true },
  ])
  const r = env.runState(['feedback-index', 'upsert', dir, '--from', resolved])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(parse<UpsertJson>(r), { inserted: 0, updated: 2, resolvedFromGithub: 0, total: 2 })

  const read = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  const byId = new Map(read.comments.map(c => [c.externalId, c]))
  assert.equal(byId.get('201')?.status, 'ignored')
  assert.equal(byId.get('202')?.status, 'not_needed')
  // github field still refreshes even though status is frozen.
  assert.equal(byId.get('201')?.githubResolved, true)
})

test('feedback-index set: happy path writes status+commit, idempotent no-op, unknown status / unknown externalId each exit 1', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])
  const from = writeFrom(dir, 'fetch.json', [
    { externalId: '301', threadId: 'T301', deliverableId: 'D1', pr: 'https://gh/pr/1', path: 'src/a.ts', line: 3, author: 'octocat', body: 'a', githubResolved: false },
  ])
  env.runState(['feedback-index', 'upsert', dir, '--from', from])

  const set = env.runState(['feedback-index', 'set', dir, '301', 'addressed', '--commit', 'abc123'])
  assert.equal(set.status, 0, set.stderr)
  assert.deepEqual(parse<SetJson>(set), { externalId: '301', from: 'unaddressed', to: 'addressed', commit: 'abc123', changed: true })

  const noop = env.runState(['feedback-index', 'set', dir, '301', 'addressed'])
  assert.equal(noop.status, 0, noop.stderr)
  assert.deepEqual(parse<SetJson>(noop), { externalId: '301', from: 'addressed', to: 'addressed', commit: 'abc123', changed: false })

  const badStatus = env.runState(['feedback-index', 'set', dir, '301', 'bogus'])
  assert.equal(badStatus.status, 1)
  assert.match(badStatus.stderr, /unknown feedback status "bogus"/)
  assert.equal(badStatus.stderr.trim().split('\n').length, 1)

  const badId = env.runState(['feedback-index', 'set', dir, '999', 'resolved'])
  assert.equal(badId.status, 1)
  assert.match(badId.stderr, /unknown externalId "999"/)

  // The persisted state is unchanged by the two failed calls.
  const read = parse<ReadJson>(env.runState(['feedback-index', 'read', dir]))
  assert.equal(read.comments.find(c => c.externalId === '301')?.status, 'addressed')
})

test('feedback-index: misuse and unknown subcommand exit 1 with one stderr line', () => {
  const env = makeStateEnv()
  const dir = env.writeRun('my-run', [{ id: 'D1' }])
  const noSub = env.runState(['feedback-index'])
  assert.equal(noSub.status, 1)
  assert.match(noSub.stderr, /feedback-index <read\|upsert\|set>/)

  const badSub = env.runState(['feedback-index', 'frobnicate', dir])
  assert.equal(badSub.status, 1)
  assert.match(badSub.stderr, /feedback-index <read\|upsert\|set>/)

  const setOnMissingIndex = env.runState(['feedback-index', 'set', dir, '1', 'resolved'])
  assert.equal(setOnMissingIndex.status, 1)
  assert.match(setOnMissingIndex.stderr, /no feedback index/)
})
