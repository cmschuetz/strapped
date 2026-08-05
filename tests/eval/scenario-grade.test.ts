// Scenario graders: built-in correctness graders against a
// fabricated ScenarioOutcome over a REAL temp sandbox, the deterministic
// adherence suite against a well-formed state root and each seeded violation,
// and the weighted-mean aggregation. Fully offline — the only model boundary
// (scenarioJudge) is a scripted fake spawn.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'bun:test'
import type { GradeResult } from '../../src/eval/grade.ts'
import {
  adherenceGraders,
  artifactAssert,
  commandGrader,
  gradeScenario,
  scenarioJudge,
} from '../../src/eval/scenario/grade.ts'
import { buildSandbox, removeSandbox } from '../../src/eval/scenario/sandbox.ts'
import type { Scenario, ScenarioOutcome, ScenarioSandbox } from '../../src/eval/scenario/types.ts'
import type { Spawn } from '../../src/eval/types.ts'
import { errorEnvelope, fakeSpawn, successEnvelope } from '../helpers/fake-claude.ts'

const SLUG = 'grade-test'

const manifest = (status: string): string => `---\nslug: ${SLUG}\nstatus: ${status}\nseed: 7\n---\n# Theme\n`

const deliverable = (fields: Record<string, string>): string => {
  const base: Record<string, string> = {
    id: 'D1',
    title: 'Thing',
    deps: '[]',
    repo: 'alpha',
    status: 'done',
    branch: `strapped/${SLUG}/D1-thing`,
    base: 'main',
    worktree: '{{repoRoot:alpha}}',
  }
  const merged = { ...base, ...fields }
  const lines = Object.entries(merged)
    .filter(([, v]) => v !== '__omit__')
    .map(([k, v]) => `${k}: ${v}`)
  return `---\n${lines.join('\n')}\n---\n## Context\n`
}

const ROUND_RECORD = '---\nround: 1\n---\nrecord\n'

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: SLUG,
    tags: ['test'],
    stages: ['plan', 'implement'],
    ask: 'Add a subtract function and a test for it.',
    repos: [{ name: 'alpha', files: { 'CLAUDE.md': '# fixture', 'README.md': 'hello fixture' }, validations: [] }],
    seedRunState: {
      files: {
        'manifest.md': manifest('implementing'),
        'deliverables/D1-thing.md': deliverable({}),
        'reviews/plan-round-1.md': ROUND_RECORD,
        'reviews/D1-code-round-1.md': ROUND_RECORD,
      },
    },
    rules: [],
    correctness: [],
    expect: { manifestStatus: 'implementing', completed: ['plan', 'implement'], stoppedAt: null },
    seed: 7,
    planRounds: 1,
    codeRounds: 1,
    confidenceMin: 70,
    ...overrides,
  }
}

function outcomeFor(scenario: Scenario, sandbox: ScenarioSandbox, over: Partial<ScenarioOutcome> = {}): ScenarioOutcome {
  return {
    scenario,
    sandbox,
    runResult: {
      slug: SLUG,
      stages: scenario.stages,
      completed: ['plan', 'implement'],
      stoppedAt: null,
      results: {},
    },
    error: null,
    ledger: [],
    wallClockMs: 5,
    totals: { costUsd: 0, turns: 0, agentCalls: 0, durationMs: 0, apiDurationMs: 0 },
    phases: [],
    logs: [],
    ...over,
  }
}

/** Build the scenario's sandbox, run the body, always tear down. */
function withSandbox(scenario: Scenario, body: (sandbox: ScenarioSandbox) => void): void {
  const sandbox = buildSandbox(scenario)
  try {
    body(sandbox)
  } finally {
    removeSandbox(sandbox)
  }
}

/** Simulate one `state.mjs` transition auto-commit beyond the sandbox seed. */
function commitBeyondSeed(sandbox: ScenarioSandbox): void {
  writeFileSync(join(sandbox.runDir, 'transition-marker'), 'flipped')
  const add = spawnSync('git', ['-C', sandbox.stateRoot, 'add', '-A'], { encoding: 'utf8' })
  assert.equal(add.status, 0, add.stderr)
  const commit = spawnSync('git', ['-C', sandbox.stateRoot, 'commit', '-q', '-m', 'state: transition'], {
    encoding: 'utf8',
  })
  assert.equal(commit.status, 0, commit.stderr)
}

function runAdherence(outcome: ScenarioOutcome): GradeResult[] {
  return adherenceGraders().map(g => g(outcome, {}))
}

function byName(grades: readonly GradeResult[], name: string): GradeResult {
  const found = grades.find(g => g.name === name)
  assert.ok(found !== undefined, `no grade named ${name}`)
  return found
}

// --- built-in correctness graders ---------------------------------------------

test('commandGrader passes on exit 0 with the output tail as detail', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const grade = commandGrader('greets', 'cat README.md', { cwd: '{repoRoot:alpha}' })(outcome, {})
    assert.equal(grade.pass, true)
    assert.equal(grade.score, 1)
    assert.match(grade.detail, /hello fixture/)
  })
})

test('commandGrader fails on a nonzero exit with the exit code in the detail', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const grade = commandGrader('boom', 'echo broken && exit 3', { cwd: '{runDir}' })(outcome, {})
    assert.equal(grade.pass, false)
    assert.equal(grade.score, 0)
    assert.match(grade.detail, /exit 3/)
    assert.match(grade.detail, /broken/)
  })
})

test('commandGrader resolves {worktree:<Did>} from the deliverable frontmatter', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    // The seeded D1 worktree points at the alpha repo root, so the file is there.
    const grade = commandGrader('in-worktree', 'test -f CLAUDE.md', { cwd: '{worktree:D1}' })(outcome, {})
    assert.equal(grade.pass, true, grade.detail)
  })
})

test('commandGrader grades a token error as a fail, never a throw', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const missing = commandGrader('bad-worktree', 'true', { cwd: '{worktree:D9}' })(outcome, {})
    assert.equal(missing.pass, false)
    assert.match(missing.detail, /D9/)
    const unknown = commandGrader('bad-token', 'echo {bogus}')(outcome, {})
    assert.equal(unknown.pass, false)
    assert.match(unknown.detail, /unknown sandbox token \{bogus\}/)
  })
})

test('artifactAssert passes/fails on the predicate and never propagates a throw', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    assert.equal(artifactAssert('ok', o => o.error === null)(outcome, {}).pass, true)
    assert.equal(artifactAssert('nope', () => false)(outcome, {}).pass, false)
    const thrown = artifactAssert('threw', () => {
      throw new Error('bad predicate')
    })(outcome, {})
    assert.equal(thrown.pass, false)
    assert.match(thrown.detail, /bad predicate/)
  })
})

test('scenarioJudge routes rendered evidence through the injected spawn', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const inputs: string[] = []
    const spawn: Spawn = (_cmd, _args, input) => {
      inputs.push(input ?? '')
      return { status: 0, stdout: JSON.stringify(successEnvelope({ score: 0.8, pass: true, reason: 'solid' })), stderr: '' }
    }
    const grade = scenarioJudge('Is the produced diff good?', {
      model: 'claude-haiku-4-5',
      render: o => `EVIDENCE for ${o.scenario.id}`,
    })(outcome, { spawn })
    assert.equal(grade.pass, true)
    assert.equal(grade.score, 0.8)
    assert.equal(grade.detail, 'solid')
    assert.equal(grade.name, 'scenarioJudge')
    assert.match(inputs[0] ?? '', /EVIDENCE for grade-test/)
  })
})

test('scenarioJudge grades a judge failure or a thrown render as a fail', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const failed = scenarioJudge('rubric', { model: 'm' })(outcome, { spawn: fakeSpawn(errorEnvelope()) })
    assert.equal(failed.pass, false)
    assert.equal(failed.score, 0)
    const thrown = scenarioJudge('rubric', {
      model: 'm',
      render: () => {
        throw new Error('render exploded')
      },
    })(outcome, { spawn: fakeSpawn(successEnvelope({ score: 1, pass: true, reason: 'x' })) })
    assert.equal(thrown.pass, false)
    assert.match(thrown.detail, /render exploded/)
  })
})

// --- adherence suite ------------------------------------------------------------

test('adherence suite passes on a well-formed sandbox state root', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)
    const grades = runAdherence(outcome)
    for (const g of grades) assert.ok(g.pass, `${g.name}: ${g.detail}`)
    assert.equal(gradeScenario(outcome).adherence, 1)
  })
})

test('manifest below the expected status (or off-ladder, or missing) fails the manifest check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)

    writeFileSync(join(sandbox.runDir, 'manifest.md'), manifest('draft'))
    const below = byName(runAdherence(outcome), 'adherence:manifest')
    assert.equal(below.pass, false)
    assert.match(below.detail, /"draft" below expected "implementing"/)

    writeFileSync(join(sandbox.runDir, 'manifest.md'), manifest('bogus'))
    const offLadder = byName(runAdherence(outcome), 'adherence:manifest')
    assert.equal(offLadder.pass, false)
    assert.match(offLadder.detail, /"bogus" is not on the ladder/)

    unlinkSync(join(sandbox.runDir, 'manifest.md'))
    const missing = byName(runAdherence(outcome), 'adherence:manifest')
    assert.equal(missing.pass, false)
    assert.match(missing.detail, /no manifest\.md/)
  })
})

test('a missing required frontmatter field or illegal status fails the deliverable check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)
    const file = join(sandbox.runDir, 'deliverables', 'D1-thing.md')

    writeFileSync(file, deliverable({ repo: '__omit__' }).replace('{{repoRoot:alpha}}', '/tmp/x'))
    const missing = byName(runAdherence(outcome), 'adherence:deliverable-frontmatter')
    assert.equal(missing.pass, false)
    assert.match(missing.detail, /missing "repo"/)

    writeFileSync(file, deliverable({ status: 'half-done' }).replace('{{repoRoot:alpha}}', '/tmp/x'))
    const illegal = byName(runAdherence(outcome), 'adherence:deliverable-frontmatter')
    assert.equal(illegal.pass, false)
    assert.match(illegal.detail, /illegal status "half-done"/)
  })
})

test('a malformed branch name fails the branch check with the file named', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)
    writeFileSync(
      join(sandbox.runDir, 'deliverables', 'D1-thing.md'),
      deliverable({ branch: 'feature/wrong-shape' }).replace('{{repoRoot:alpha}}', '/tmp/x')
    )
    const grade = byName(runAdherence(outcome), 'adherence:branch-names')
    assert.equal(grade.pass, false)
    assert.match(grade.detail, /D1-thing\.md/)
    assert.match(grade.detail, /feature\/wrong-shape/)
  })
})

test('a dangling dep fails the deps check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)
    writeFileSync(
      join(sandbox.runDir, 'deliverables', 'D1-thing.md'),
      deliverable({ deps: '[D9]' }).replace('{{repoRoot:alpha}}', '/tmp/x')
    )
    const grade = byName(runAdherence(outcome), 'adherence:deps')
    assert.equal(grade.pass, false)
    assert.match(grade.detail, /dep "D9"/)
  })
})

test('missing review round records fail their checks for the stages that ran', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox)

    unlinkSync(join(sandbox.runDir, 'reviews', 'plan-round-1.md'))
    const plan = byName(runAdherence(outcome), 'adherence:plan-review-records')
    assert.equal(plan.pass, false)
    assert.match(plan.detail, /plan-round-1\.md/)

    unlinkSync(join(sandbox.runDir, 'reviews', 'D1-code-round-1.md'))
    const code = byName(runAdherence(outcome), 'adherence:code-review-records')
    assert.equal(code.pass, false)
    assert.match(code.detail, /code-round/)
  })
})

test('a state root without .git fails the commit-cadence check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    rmSync(join(sandbox.stateRoot, '.git'), { recursive: true, force: true })
    const grade = byName(runAdherence(outcomeFor(scenario, sandbox)), 'adherence:state-commits')
    assert.equal(grade.pass, false)
    assert.match(grade.detail, /no \.git/)
  })
})

test('no commit beyond the seed after a transitioning stage fails the cadence check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    // Deliberately NO commitBeyondSeed: only the sandbox seed commit exists.
    const grade = byName(runAdherence(outcomeFor(scenario, sandbox)), 'adherence:state-commits')
    assert.equal(grade.pass, false)
    assert.match(grade.detail, /beyond the sandbox seed commit/)
  })
})

test('the deliverable end-state check: status + parked_reason pattern pass, mismatches fail, omitted is neutral', () => {
  const scenario = baseScenario({
    expect: { manifestStatus: 'implementing', deliverables: [{ id: 'D1', status: 'done' }] },
  })
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const file = join(sandbox.runDir, 'deliverables', 'D1-thing.md')

    // PASS: the seeded D1 is `done`, matching the expectation.
    const ok = byName(runAdherence(outcomeFor(scenario, sandbox)), 'adherence:deliverable-end-state')
    assert.equal(ok.pass, true, ok.detail)

    // PASS: parked status + parked_reason matching the declared pattern.
    const parkedScenario = baseScenario({
      expect: {
        deliverables: [{ id: 'D1', status: 'parked', parkedReasonPattern: 'missing dep(endency)?' }],
      },
    })
    writeFileSync(
      file,
      deliverable({ status: 'parked', parked_reason: '"blocked on a missing dependency"' }).replace('{{repoRoot:alpha}}', '/tmp/x')
    )
    const parkedOk = byName(runAdherence(outcomeFor(parkedScenario, sandbox)), 'adherence:deliverable-end-state')
    assert.equal(parkedOk.pass, true, parkedOk.detail)

    // FAIL: parked_reason does not match the pattern.
    const wrongPattern = baseScenario({
      expect: { deliverables: [{ id: 'D1', status: 'parked', parkedReasonPattern: 'budget exhausted' }] },
    })
    const patternFail = byName(runAdherence(outcomeFor(wrongPattern, sandbox)), 'adherence:deliverable-end-state')
    assert.equal(patternFail.pass, false)
    assert.match(patternFail.detail, /does not match \/budget exhausted\//)

    // FAIL: status mismatch, with both statuses named.
    const statusFail = byName(runAdherence(outcomeFor(scenario, sandbox)), 'adherence:deliverable-end-state')
    assert.equal(statusFail.pass, false)
    assert.match(statusFail.detail, /status "parked" ≠ expected "done"/)

    // FAIL: an expected deliverable with no file at all.
    const missing = baseScenario({ expect: { deliverables: [{ id: 'D9', status: 'done' }] } })
    const missingFail = byName(runAdherence(outcomeFor(missing, sandbox)), 'adherence:deliverable-end-state')
    assert.equal(missingFail.pass, false)
    assert.match(missingFail.detail, /no deliverable file D9-\*\.md/)

    // NEUTRAL: no deliverables expectation declared → n/a with weight 0.
    const neutral = byName(runAdherence(outcomeFor(baseScenario(), sandbox)), 'adherence:deliverable-end-state')
    assert.equal(neutral.pass, true)
    assert.equal(neutral.weight, 0)
    assert.match(neutral.detail, /^n\/a/)
  })
})

test('a completed/stoppedAt mismatch fails the run-result check', () => {
  const scenario = baseScenario()
  withSandbox(scenario, sandbox => {
    commitBeyondSeed(sandbox)
    const outcome = outcomeFor(scenario, sandbox, {
      runResult: { slug: SLUG, stages: ['plan', 'implement'], completed: ['plan'], stoppedAt: 'implement', results: {} },
    })
    const grade = byName(runAdherence(outcome), 'adherence:run-result')
    assert.equal(grade.pass, false)
    assert.match(grade.detail, /completed/)
    assert.match(grade.detail, /stoppedAt/)
  })
})

test('checks that do not apply to the stage subset are neutral, not failures', () => {
  const scenario = baseScenario({
    stages: [],
    seedRunState: { files: { 'manifest.md': manifest('approved') } },
    expect: undefined,
  })
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox, { runResult: null })
    const grades = runAdherence(outcome)
    const neutral = grades.filter(g => g.detail.startsWith('n/a'))
    // With an empty stage subset everything except the manifest check is n/a:
    // no deliverable files and no producing stage, no plan/code review rounds
    // run, no status-transitioning stage, and no declared expectation.
    assert.equal(neutral.length, grades.length - 1)
    for (const g of neutral) {
      assert.equal(g.pass, true, `${g.name} must be neutral, got: ${g.detail}`)
      assert.equal(g.weight, 0)
    }
    // Neutral checks carry weight 0, so adherence rests on the one real check.
    assert.equal(gradeScenario(outcome).adherence, 1)
  })
})

// --- aggregation ----------------------------------------------------------------

test('gradeScenario aggregates via the weighted-mean rule; empty set ⇒ 0', () => {
  const scenario = baseScenario({
    correctness: [
      artifactAssert('always-pass', () => true),
      artifactAssert('always-fail', () => false, { weight: 3 }),
    ],
    adherence: [artifactAssert('adhered', () => true)],
  })
  withSandbox(scenario, sandbox => {
    const outcome = outcomeFor(scenario, sandbox)
    const graded = gradeScenario(outcome)
    // (1·1 + 3·0) / 4 = 0.25
    assert.equal(graded.correctness, 0.25)
    assert.equal(graded.correctnessGrades.length, 2)
    // A declared adherence set REPLACES the built-in suite.
    assert.equal(graded.adherence, 1)
    assert.deepEqual(
      graded.adherenceGrades.map(g => g.name),
      ['adhered']
    )

    const empty = gradeScenario(outcomeFor(baseScenario({ correctness: [], adherence: [] }), sandbox))
    assert.equal(empty.correctness, 0)
    assert.equal(empty.adherence, 0)
  })
})

test('a throwing custom grader becomes a failed grade, not a crash', () => {
  const scenario = baseScenario({
    correctness: [
      () => {
        throw new Error('rogue grader')
      },
    ],
  })
  withSandbox(scenario, sandbox => {
    const graded = gradeScenario(outcomeFor(scenario, sandbox))
    assert.equal(graded.correctness, 0)
    assert.match(graded.correctnessGrades[0]?.detail ?? '', /rogue grader/)
  })
})
