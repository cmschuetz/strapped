// Harness eval case: the PLANNER prompt.
//
// The `prompt` below is a baseline snapshot copied verbatim from the planner
// `agent<PlanResult>(…)` call in `src/workflows/strapped-run/stages/plan.ts`, with
// the runtime `${...}` holes filled by fixture constants. Do NOT import the stage
// module — its prompt is interpolated at runtime; this is an eval INPUT.
// D4 may compact this text and A/B the candidate against this baseline.

import { defineCase } from '../../case.ts'
import { assert, schemaConforms } from '../../grade.ts'
import { PLAN_SCHEMA } from '../../../workflows/strapped-run/schemas.generated.ts'
import {
  asSchema,
  FIXTURE_CONFIDENCE_MIN,
  FIXTURE_CONVENTIONS,
  FIXTURE_CODE_ROUNDS,
  FIXTURE_DIR,
  FIXTURE_PLAN_ROUNDS,
  FIXTURE_REPOS,
  FIXTURE_SEED,
  FIXTURE_SLUG,
  FIXTURE_STATE_SCRIPT,
  STRAPPED_CONTEXT,
} from './fixtures/context.ts'
import { FIXTURE_SOURCE_PLAN } from './fixtures/source-plan.ts'

/** Parsed planner output shape (mirrors `PlanResult`). */
interface PlanOutput {
  deliverables?: Array<{ id?: unknown; file?: unknown; title?: unknown; deps?: unknown }>
  summary?: unknown
}

const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

const PLANNER_PROMPT = `You are the planning agent for strapped run "${FIXTURE_SLUG}". Produce a complete, reviewable implementation plan from a large source plan document.

Source plan (the original ask): ${FIXTURE_SOURCE_PLAN}
Target repos (the run state is keyed by the run slug, not by any repo; the work spans these repos — an unordered set):
${FIXTURE_REPOS}
Output directory (already scaffolded): ${FIXTURE_DIR}
Conventions you MUST follow for every file format: ${FIXTURE_CONVENTIONS}

Procedure:
1. Read the source plan in full, then research each target repo's codebase thoroughly: architecture, the modules the ask touches, existing utilities to reuse, test patterns.
2. Write ${FIXTURE_DIR}/research.md — a distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see.
3. Split the work into deliverables by discrete theme, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR — split a theme into multiple deliverables only when its estimated meaningful diff (excluding generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures) exceeds ~1,000 changed lines. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs. Assign each deliverable to exactly one target repo.
4. Write one self-contained file per deliverable at ${FIXTURE_DIR}/deliverables/<id>-<kebab>.md per the conventions (ids are EXACTLY D1, D2, D3, ... — capital D then the ordinal, in filenames, frontmatter, branches, and deps alike) (frontmatter: id, title, deps, repo: <one of the target repo names above>, status: pending, branch: strapped/${FIXTURE_SLUG}/<id>-<kebab>, base, worktree: null, pr: null, review_rounds_used: 0, feedback_rounds_used: 0, parked_reason: null, estimated_diff_lines; body sections under these EXACT verbatim headers — \`## Context\`, \`## Files to touch\`, \`## Implementation steps\`, \`## Acceptance criteria\`, \`## Tests\`, \`## Out of scope\` — the review machinery keys on the \`## Acceptance criteria\` header literally, so no case or wording variation). Set base per the cross-repo base rule: a deliverable's base is a parent branch WITHIN THE SAME repo, otherwise that repo's main (roots, and any cross-repo child, base on their own repo's main — you can never branch across repos). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. Cross-repo deps are ordering-only, NEVER a code dependency: a cross-repo child bases on its own repo's main and does not have its parent's unmerged code. Reject or restructure any plan where a cross-repo child has a true code dependency on its parent — either require the shared change to merge to the parent repo's main first, or keep both sides in the same repo/chain.
6. Write ${FIXTURE_DIR}/manifest.md per the conventions (status: in-review, seed: ${FIXTURE_SEED}, budgets — record the EFFECTIVE budgets of this run: plan_rounds: ${FIXTURE_PLAN_ROUNDS}, code_rounds: ${FIXTURE_CODE_ROUNDS}, confidence_min: ${FIXTURE_CONFIDENCE_MIN} — the repos: map listing every target repo above per the conventions — name, root, config path (repos: is an unordered set, no repo is special); the deliverables list with ids/files/repos/deps, theme summary, ASCII DAG sketch).
7. After all plan artifacts are written, run \`node ${FIXTURE_STATE_SCRIPT} commit ${FIXTURE_DIR}\` via Bash so the run's state root is git-backed from birth (it git-inits the state root if absent and commits the artifacts). Best-effort: proceed even if it reports an error.

Return the deliverable list and a one-paragraph summary.`

export const plannerCase = defineCase({
  id: 'planner',
  tags: ['planner'],
  appendSystemPrompt: STRAPPED_CONTEXT,
  prompt: PLANNER_PROMPT,
  schema: asSchema(PLAN_SCHEMA),
  graders: [
    schemaConforms(),
    // Discriminator: the ask has independently-testable pieces (a pure resolver,
    // the flag, the JSON mode, docs) → a real planner returns more than one.
    assert('at-least-two-deliverables', o => {
      const ds = (o as PlanOutput).deliverables
      return Array.isArray(ds) && ds.length >= 2
    }),
    assert('deliverables-well-formed', o => {
      const ds = (o as PlanOutput).deliverables
      if (!Array.isArray(ds) || ds.length === 0) return false
      return ds.every(d => nonEmptyString(d.id) && nonEmptyString(d.file) && nonEmptyString(d.title) && Array.isArray(d.deps))
    }),
    assert('non-empty-summary', o => nonEmptyString((o as PlanOutput).summary)),
  ],
})
