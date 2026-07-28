// The harness prompt-eval SUITE: modular cases that exercise the strapped
// harness's REAL agent prompts (baseline snapshots) against their REAL forced
// schemas from `schemas.generated.ts`. Each case is one file so covering a new
// harness feature is a single-file add. The D2 CLI loads the `cases` export
// below when pointed at this directory.
//
// Run it live (needs a real `claude`; NOT part of `bun test`):
//   bun run eval --suite src/eval/suites/harness
//   bun run eval --suite src/eval/suites/harness --filter reviewer   # by tag/id
//   bun run eval --suite src/eval/suites/harness --matrix            # model grid
//   bun run eval --suite src/eval/suites/harness --json > report.json
// A/B (`--ab`) compares a case's baseline prompt against a candidate variant;
// D4 adds the candidates when it compacts the live stage prompts.
//
// `tests/eval/harness-suite.test.ts` proves every case is well-formed and its
// graders discriminate good from bad canned outputs — fully hermetic, no `claude`.

import type { EvalCase } from '../../case.ts'
import { plannerCase } from './planner.case.ts'
import { reviewerCase } from './reviewer.case.ts'
import { refuterCase } from './refuter.case.ts'
import { implementerCase } from './implementer.case.ts'

/** The suite the CLI `--suite` loads (`cases` is the magic export name). */
export const cases: EvalCase[] = [plannerCase, reviewerCase, refuterCase, implementerCase]
