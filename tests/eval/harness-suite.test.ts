// Harness eval SUITE smoke test — fully hermetic (no real `claude`).
//
// Proves the eval CONTENT is sound without spending a cent:
//   1. every case is well-formed (id/tags/prompt/schema/graders present),
//   2. ids and primary tags are unique across the suite,
//   3. each case's graders return the expected verdict against a canned
//      `structured_output` — a GOOD output grades to correctness 1, a BAD one
//      (the discriminator's failure mode) grades strictly below 1 — driven
//      through the D2 runner (`runCase`) with the output fed via `fakeSpawn`,
//   4. the suite `index` loads through the D2 CLI loader (`loadSuite`).

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'bun:test'
import { runCase } from '../../src/eval/runner.ts'
import { loadSuite } from '../../src/eval/cli.ts'
import type { EvalCase } from '../../src/eval/case.ts'
import { cases } from '../../src/eval/suites/harness/index.ts'
import { plannerCase } from '../../src/eval/suites/harness/planner.case.ts'
import { reviewerCase } from '../../src/eval/suites/harness/reviewer.case.ts'
import { refuterCase } from '../../src/eval/suites/harness/refuter.case.ts'
import { implementerCase } from '../../src/eval/suites/harness/implementer.case.ts'
import { fakeSpawn, successEnvelope } from '../helpers/fake-claude.ts'

const SUITE_DIR = join(import.meta.dir, '..', '..', 'src', 'eval', 'suites', 'harness')

/** A canned good/bad structured_output pair for one case's graders. */
interface Fixture {
  case: EvalCase
  good: unknown
  bad: unknown
}

const FIXTURES: Fixture[] = [
  {
    case: plannerCase,
    // Three well-formed deliverables + a summary → every planner grader passes.
    good: {
      deliverables: [
        { id: 'D1', file: 'deliverables/D1-resolver.md', title: 'Pure dry-run resolver', deps: [] },
        { id: 'D2', file: 'deliverables/D2-flag.md', title: 'Wire --dry-run flag', deps: ['D1'] },
        { id: 'D3', file: 'deliverables/D3-json-and-docs.md', title: 'JSON mode + docs', deps: ['D2'] },
      ],
      summary: 'Extract a pure resolver, then layer the --dry-run flag, JSON mode, and docs on top.',
    },
    // Schema-valid but empty: fails at-least-two-deliverables + non-empty-summary.
    bad: { deliverables: [], summary: '' },
  },
  {
    case: reviewerCase,
    // A blocking finding naming the missing test + an AC violation → gap surfaced.
    good: {
      findings: [
        {
          id: 'g1',
          key: 'gap:deliverables/D1-dry-run-resolver.md',
          rule: null,
          severity: 'blocking',
          location: 'deliverables/D1-dry-run-resolver.md',
          what: 'The --dry-run --json mode (AC2) has no covering test.',
          why: 'A user-facing behavior ships untested, violating the ask.',
          evidence: 'Tests section lists resolver.test.ts and dry-run.test.ts only.',
          confidence: 90,
          recommendation: 'Add a test asserting the JSON wave-plan output shape.',
        },
      ],
      rule_checklist: [{ rule: 'CM-1', verdict: 'violation', evidence: 'AC2 has no test' }],
      ac_checklist: [
        { id: 'AC1', verdict: 'pass', evidence: 'covered by dry-run.test.ts' },
        { id: 'AC2', verdict: 'violation', evidence: 'no test covers the JSON mode' },
      ],
    },
    // Reviewer waved everything through → the seeded gap is NOT surfaced.
    bad: {
      findings: [],
      rule_checklist: [{ rule: 'CM-1', verdict: 'pass', evidence: 'looks fine' }],
      ac_checklist: [
        { id: 'AC1', verdict: 'pass', evidence: 'ok' },
        { id: 'AC2', verdict: 'pass', evidence: 'ok' },
      ],
    },
  },
  {
    case: refuterCase,
    good: { verdict: 'refuted', confidence: 15, evidence: 'The deliverable names resolver.ts in Files to touch.' },
    bad: { verdict: 'confirmed', confidence: 90, evidence: 'No target file found.' },
  },
  {
    case: implementerCase,
    // Honest single-shot outcome: blocked, validations not green, blocker set.
    good: { status: 'blocked', summary: 'Cannot implement in a single-shot eval.', validations_green: false, blocker: 'no filesystem/tool access to write code or run validations' },
    // Self-inconsistent: claims implemented while validations are red.
    bad: { status: 'implemented', summary: 'done', validations_green: false, blocker: null },
  },
]

// --- acceptance criterion 1: every case is well-formed -----------------------

test('every harness case is well-formed (id/tags/prompt/schema/graders)', () => {
  assert.equal(cases.length, 4)
  for (const c of cases) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0, `case id: ${c.id}`)
    assert.ok(Array.isArray(c.tags) && c.tags.length > 0, `case ${c.id} has tags`)
    assert.ok(typeof c.prompt === 'string' && c.prompt.trim().length > 0, `case ${c.id} has a prompt`)
    assert.ok(c.schema && typeof c.schema === 'object', `case ${c.id} has a schema`)
    assert.equal(c.schema.type, 'object', `case ${c.id} schema is an object schema`)
    assert.ok(c.schema.properties && typeof c.schema.properties === 'object', `case ${c.id} schema has properties`)
    assert.ok(Array.isArray(c.graders) && c.graders.length >= 1, `case ${c.id} has ≥1 grader`)
  }
})

test('the four required harness cases are present by id', () => {
  const ids = cases.map(c => c.id).sort()
  assert.deepEqual(ids, ['implementer', 'planner', 'refuter', 'reviewer'])
})

// --- acceptance criterion: ids + tags unique ---------------------------------

test('case ids and primary tags are unique across the suite', () => {
  const ids = cases.map(c => c.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  const tags = cases.flatMap(c => c.tags)
  assert.equal(new Set(tags).size, tags.length, 'no tag is shared between cases')
  for (const expected of ['planner', 'reviewer', 'refuter', 'implementer']) {
    assert.equal(cases.filter(c => c.tags.includes(expected)).length, 1, `exactly one case tagged ${expected}`)
  }
})

// --- acceptance criterion 2: graders discriminate good from bad --------------

for (const fx of FIXTURES) {
  test(`${fx.case.id} case: graders pass a good output and fail a bad one (canned, hermetic)`, () => {
    const good = runCase(fx.case, { model: 'claude-haiku-4-5', spawn: fakeSpawn(successEnvelope(fx.good)) })
    assert.equal(good.skipped, false)
    assert.equal(good.result.ok, true, `${fx.case.id} good output conforms to its forced schema`)
    assert.equal(good.correctness, 1, `${fx.case.id} good output grades to full correctness`)

    const bad = runCase(fx.case, { model: 'claude-haiku-4-5', spawn: fakeSpawn(successEnvelope(fx.bad)) })
    assert.ok(bad.correctness < 1, `${fx.case.id} bad output grades below full correctness (was ${bad.correctness})`)
    // At least one named grader must have flipped — proving the discriminator bites.
    assert.ok(bad.grades.some(g => !g.pass), `${fx.case.id} bad output trips a grader`)
  })
}

// --- acceptance criterion 3/4: the suite loads through the D2 CLI loader ------

test('loadSuite loads exactly the four harness cases from the suite directory', async () => {
  const loaded = await loadSuite(SUITE_DIR)
  assert.equal(loaded.length, 4)
  assert.deepEqual(loaded.map(c => c.id).sort(), ['implementer', 'planner', 'refuter', 'reviewer'])
})

test('the imported case objects are identical to the suite export', () => {
  assert.equal(cases.includes(plannerCase), true)
  assert.equal(cases.includes(reviewerCase), true)
  assert.equal(cases.includes(refuterCase), true)
  assert.equal(cases.includes(implementerCase), true)
})
