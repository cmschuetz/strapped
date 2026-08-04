// The harness SCENARIO suite: full-workflow evaluations that run the REAL
// shipped deployable (plugins/strapped/workflows/strapped-run.js) against a
// sandboxed fixture repo + ask, grading the whole run on correctness /
// adherence / time / price. One scenario per file; the CLI loads the
// `scenarios` export below when pointed at this directory.
//
// COST WARNING — these are HEAVY: every `agent()` call is a real multi-turn
// agentic `claude -p` run, so a live scenario costs real dollars and MINUTES
// (a full-pipeline run dispatches ~10+ agents). Keep asks tiny (one-function
// scale) and fixture repos small with cheap validations. The pr stage is
// always forced dry-run by the executor.
//
// Run live (needs a real `claude`; NOT part of `bun test`):
//   bun run eval --scenarios src/eval/scenarios/harness
//   bun run eval --scenarios src/eval/scenarios/harness --filter plan-only    # by id
//   bun run eval --scenarios src/eval/scenarios/harness --filter implement    # by tag
//   bun run eval --scenarios src/eval/scenarios/harness --json > baseline.json
// Before/after a WORKFLOW change, save two --json reports and gate with:
//   bun run eval --compare baseline.json candidate.json [--tolerance <pct>]
// The review-loop scenario exists so --compare can show improvement, not just
// non-regression: its seeded-defect/nit graders discriminate between workflow
// variants instead of saturating at 1.0 on the happy path.
//
// `tests/eval/harness-scenarios.test.ts` proves every scenario is well-formed,
// its seeded state is accepted by the real state.mjs, and its graders
// discriminate canned good from bad outcomes — fully hermetic, no `claude`.

import type { Scenario } from '../../scenario/types.ts'
import { dirtyBranchScenario } from './dirty-branch.scenario.ts'
import { fullPipelineScenario } from './full-pipeline.scenario.ts'
import { implementOnlyScenario } from './implement-only.scenario.ts'
import { manyRulesScenario } from './many-rules.scenario.ts'
import { planOnlyScenario } from './plan-only.scenario.ts'
import { reviewLoopScenario } from './review-loop.scenario.ts'
import { zeroRoundsScenario } from './zero-rounds.scenario.ts'

/** The suite the CLI `--scenarios` loads (`scenarios` is the magic export name). */
export const scenarios: Scenario[] = [
  fullPipelineScenario,
  planOnlyScenario,
  implementOnlyScenario,
  reviewLoopScenario,
  zeroRoundsScenario,
  manyRulesScenario,
  dirtyBranchScenario,
]
