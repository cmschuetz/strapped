// buildSandbox/removeSandbox against real git in temp dirs (D1 AC3/AC10/AC11):
// fixture repo + state root both git-initialized with identity and commits,
// config.json + runDir scaffold + source plan + seedRunState materialized,
// sandbox-token interpolation, and the opt-in snapshotPath heavy tier.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { buildSandbox, removeSandbox, scenarioSlug } from '../../src/eval/scenario/sandbox.ts'
import type { Scenario, ScenarioSandbox } from '../../src/eval/scenario/types.ts'

const STATE_MJS = fileURLToPath(new URL('../../plugins/strapped/scripts/state.mjs', import.meta.url))

function git(cwd: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`)
  return res.stdout.trim()
}

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: 'Sandbox Test',
    tags: [],
    stages: ['plan'],
    ask: 'Add a subtract function and a test for it.',
    repos: [
      {
        name: 'alpha',
        files: { 'CLAUDE.md': '# fixture guidelines', 'README.md': 'fixture repo' },
        validations: ['bun test'],
      },
    ],
    rules: [],
    seed: 1,
    planRounds: 1,
    codeRounds: 1,
    confidenceMin: 70,
    ...overrides,
  }
}

/** Build, run the assertions, always tear down. */
function withSandbox(scenario: Scenario, body: (sandbox: ScenarioSandbox) => void): void {
  const sandbox = buildSandbox(scenario)
  try {
    body(sandbox)
  } finally {
    removeSandbox(sandbox)
  }
}

test('fixture repo: git-initialized on main with local identity and an initial commit (AC3)', () => {
  withSandbox(baseScenario(), sandbox => {
    const repo = sandbox.repos[0]
    assert.ok(repo !== undefined)
    assert.equal(repo.name, 'alpha')
    assert.ok(existsSync(join(repo.root, '.git')))
    assert.equal(readFileSync(join(repo.root, 'CLAUDE.md'), 'utf8'), '# fixture guidelines')
    assert.equal(git(repo.root, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.equal(git(repo.root, 'config', 'user.name'), 'strapped-eval')
    assert.equal(git(repo.root, 'config', 'user.email'), 'eval@localhost')
    assert.equal(git(repo.root, 'rev-list', '--count', 'HEAD'), '1')
    assert.equal(git(repo.root, 'status', '--porcelain'), '') // everything committed
    assert.ok(existsSync(repo.worktreeRoot))
  })
})

test('state root: git-initialized with a seed commit, and a state.mjs transition auto-commits (AC3)', () => {
  const scenario = baseScenario({
    seedRunState: {
      files: {
        'deliverables/D1-thing.md': '---\nid: D1\ntitle: Thing\nstatus: pending\n---\n\n## Context\nseeded\n',
      },
    },
  })
  withSandbox(scenario, sandbox => {
    assert.ok(existsSync(join(sandbox.stateRoot, '.git')))
    assert.equal(git(sandbox.stateRoot, 'symbolic-ref', '--short', 'HEAD'), 'main')
    assert.equal(git(sandbox.stateRoot, 'rev-parse', 'HEAD'), sandbox.stateSeedCommit)
    assert.equal(git(sandbox.stateRoot, 'rev-list', '--count', 'HEAD'), '1')

    // The transition auto-commit cadence engages ONLY because the state root
    // already has .git — this proves stage-scoped runs produce commits beyond
    // the seed commit for D2's adherence check to count.
    const deliverable = join(sandbox.runDir, 'deliverables', 'D1-thing.md')
    const res = spawnSync('node', [STATE_MJS, 'transition', deliverable, 'in-progress'], { encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.equal(git(sandbox.stateRoot, 'rev-list', '--count', 'HEAD'), '2')
    assert.notEqual(git(sandbox.stateRoot, 'rev-parse', 'HEAD'), sandbox.stateSeedCommit)
  })
})

test('scaffold: config.json content, runDir skeleton, source plan, seedRunState files (AC3)', () => {
  const scenario = baseScenario({
    seedRunState: { files: { 'research.md': 'seeded research for {{stateRoot}}' } },
  })
  withSandbox(scenario, sandbox => {
    assert.equal(sandbox.slug, 'sandbox-test')
    assert.equal(scenarioSlug('Sandbox Test'), 'sandbox-test')
    assert.equal(sandbox.runDir, join(sandbox.stateRoot, 'runs', 'sandbox-test'))

    const repo = sandbox.repos[0]
    assert.ok(repo !== undefined)
    const config = JSON.parse(readFileSync(repo.configPath, 'utf8')) as Record<string, unknown>
    assert.deepEqual(config, { validations: ['bun test'], worktreeRoot: repo.worktreeRoot, provisioning: '' })

    for (const sub of ['deliverables', 'reviews', 'critiques']) {
      assert.ok(existsSync(join(sandbox.runDir, sub)), `missing runDir scaffold dir ${sub}`)
    }
    assert.equal(readFileSync(sandbox.sourcePlan, 'utf8'), scenario.ask)
    assert.equal(
      readFileSync(join(sandbox.runDir, 'research.md'), 'utf8'),
      `seeded research for ${sandbox.stateRoot}`
    )
  })
})

test('token interpolation: all four tokens substitute to real absolute paths (AC10)', () => {
  const scenario = baseScenario({
    repos: [
      {
        name: 'alpha',
        files: { 'PATHS.md': 'root={{sandboxRoot}} state={{stateRoot}} repo={{repoRoot:alpha}} cfg={{configPath:alpha}}' },
        validations: ['bun test'],
      },
    ],
    seedRunState: {
      files: {
        'manifest.md':
          '---\nstatus: approved\nrepos:\n  - name: alpha\n    root: {{repoRoot:alpha}}\n    config: {{configPath:alpha}}\n---\n',
      },
    },
  })
  withSandbox(scenario, sandbox => {
    const repo = sandbox.repos[0]
    assert.ok(repo !== undefined)
    assert.equal(
      readFileSync(join(repo.root, 'PATHS.md'), 'utf8'),
      `root=${sandbox.root} state=${sandbox.stateRoot} repo=${repo.root} cfg=${repo.configPath}`
    )

    // A seeded manifest's repos: map ends up with real, existing absolute
    // sandbox paths — unknowable in a static literal before mkdtemp.
    const manifest = readFileSync(join(sandbox.runDir, 'manifest.md'), 'utf8')
    assert.ok(!manifest.includes('{{'))
    const rootLine = manifest.match(/^ {4}root: (.+)$/m)
    const configLine = manifest.match(/^ {4}config: (.+)$/m)
    assert.ok(rootLine?.[1] !== undefined && configLine?.[1] !== undefined)
    assert.equal(rootLine[1], repo.root)
    assert.ok(existsSync(rootLine[1]))
    assert.ok(existsSync(configLine[1]))
  })
})

test('an unknown token throws at build time (AC10)', () => {
  assert.throws(
    () =>
      buildSandbox(
        baseScenario({
          repos: [{ name: 'alpha', files: { 'x.txt': 'oops {{bogusToken}}' }, validations: [] }],
        })
      ),
    /unknown sandbox token \{\{bogusToken\}\}/
  )
})

test('a repo with neither files nor snapshotPath throws', () => {
  assert.throws(
    () => buildSandbox(baseScenario({ repos: [{ name: 'alpha', validations: [] }] })),
    /neither files nor snapshotPath/
  )
})

test('snapshotPath tier: snapshot copied, files overlaid, committed git repo with identity (AC11)', () => {
  const snapshot = mkdtempSync(join(tmpdir(), 'scenario-snapshot-'))
  try {
    mkdirSync(join(snapshot, 'src'), { recursive: true })
    writeFileSync(join(snapshot, 'src', 'app.js'), 'export const app = 1\n')
    writeFileSync(join(snapshot, 'README.md'), 'original readme\n')

    const scenario = baseScenario({
      repos: [
        {
          name: 'alpha',
          snapshotPath: snapshot,
          files: { 'README.md': 'overlaid readme', 'CLAUDE.md': '# overlay' },
          validations: ['bun test'],
        },
      ],
    })
    withSandbox(scenario, sandbox => {
      const repo = sandbox.repos[0]
      assert.ok(repo !== undefined)
      assert.equal(readFileSync(join(repo.root, 'src', 'app.js'), 'utf8'), 'export const app = 1\n')
      assert.equal(readFileSync(join(repo.root, 'README.md'), 'utf8'), 'overlaid readme') // overlay wins
      assert.equal(readFileSync(join(repo.root, 'CLAUDE.md'), 'utf8'), '# overlay')
      assert.equal(git(repo.root, 'symbolic-ref', '--short', 'HEAD'), 'main')
      assert.equal(git(repo.root, 'config', 'user.name'), 'strapped-eval')
      assert.equal(git(repo.root, 'rev-list', '--count', 'HEAD'), '1')
      assert.equal(git(repo.root, 'status', '--porcelain'), '')
    })
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
})

test('snapshotPath with a .git history: no re-init, overlay committed on top (AC11)', () => {
  const snapshot = mkdtempSync(join(tmpdir(), 'scenario-snapshot-git-'))
  try {
    writeFileSync(join(snapshot, 'README.md'), 'original readme\n')
    git(snapshot, 'init', '-q', '-b', 'trunk')
    git(snapshot, 'config', 'user.name', 'upstream')
    git(snapshot, 'config', 'user.email', 'upstream@localhost')
    git(snapshot, 'add', '-A')
    git(snapshot, 'commit', '-q', '-m', 'snapshot history')

    const scenario = baseScenario({
      repos: [{ name: 'alpha', snapshotPath: snapshot, files: { 'CLAUDE.md': '# overlay' }, validations: [] }],
    })
    withSandbox(scenario, sandbox => {
      const repo = sandbox.repos[0]
      assert.ok(repo !== undefined)
      // History preserved (no re-init): snapshot commit + overlay commit, and
      // the snapshot's own branch name survives.
      assert.equal(git(repo.root, 'rev-list', '--count', 'HEAD'), '2')
      assert.equal(git(repo.root, 'symbolic-ref', '--short', 'HEAD'), 'trunk')
      assert.equal(git(repo.root, 'config', 'user.name'), 'strapped-eval') // local identity still set
      assert.equal(readFileSync(join(repo.root, 'README.md'), 'utf8'), 'original readme\n')
      assert.equal(readFileSync(join(repo.root, 'CLAUDE.md'), 'utf8'), '# overlay')
    })
  } finally {
    rmSync(snapshot, { recursive: true, force: true })
  }
})

test('removeSandbox deletes the whole tree (AC3)', () => {
  const sandbox = buildSandbox(baseScenario())
  assert.ok(existsSync(sandbox.root))
  removeSandbox(sandbox)
  assert.ok(!existsSync(sandbox.root))
})
