// Shared fixture constants for the harness eval suite. Each case fills the
// runtime `${...}` holes of a live stage prompt with these concrete values, so a
// snapshot reads as a real agent invocation against a small, deterministic
// context (fidelity note in the D3 plan). Kept tiny so cases run fast and cache
// well.

import type { JsonSchema } from '../../../types.ts'

/**
 * Adapt a generated schema constant to the engine's structural `JsonSchema`
 * shape. The generated schemas use JSON-Schema `type: ["string","null"]` unions
 * that don't match `JsonSchema`'s shallow `type?: string`, so a direct
 * `X as JsonSchema` would trip TypeScript's "may be a mistake" narrowing guard
 * and a double `as unknown as JsonSchema` is banned repo-wide
 * (`tests/no-type-workarounds.test.ts`). Widening to `object` first lets a single
 * assertion narrow cleanly. The engine only reads top-level `type`/`properties`/
 * `required`/`additionalProperties`, all present and correct on every schema.
 */
export function asSchema(schema: object): JsonSchema {
  return schema as JsonSchema
}

/** Run slug the fixture prompts are keyed to. */
export const FIXTURE_SLUG = 'eval-fixture'
/** Scaffolded output directory the plan/review prompts reference. */
export const FIXTURE_DIR = 'plans/runs/eval-fixture'
/** Conventions file every stage prompt points at. */
export const FIXTURE_CONVENTIONS = 'plugins/strapped/conventions.md'
/** State script path the planner/coordinator prompts shell out to. */
export const FIXTURE_STATE_SCRIPT = 'scripts/state.mjs'
/** Deterministic seed + effective budgets recorded in the manifest prompt. */
export const FIXTURE_SEED = 1
export const FIXTURE_PLAN_ROUNDS = 2
export const FIXTURE_CODE_ROUNDS = 2
export const FIXTURE_CONFIDENCE_MIN = 70

/** `repoList(a.repos)` output for a single-repo fixture run. */
export const FIXTURE_REPOS = '- strapped → /home/user/strapped'

/**
 * The strapped operating context layered on the real agent prompt via
 * `--append-system-prompt` (fidelity note). Deliberately compact — it names the
 * harness role and the one hard rule an agent must respect, approximating the
 * session-start context injection without pulling in the whole thing.
 */
export const STRAPPED_CONTEXT = `You are an agent inside the strapped orchestration harness. You return a single
schema-forced JSON completion — no tool use in this evaluation context. Honor the
stage contract exactly: produce the structured output the prompt asks for, and
never invent state you cannot verify.`

/**
 * The two plan-review lenses, snapshotted verbatim from `PLAN_LENSES` in
 * `src/workflows/strapped-run/review-loop.ts`. The reviewer case runs the
 * completeness lens (`a`, which catches an acceptance-criterion with no test);
 * the soundness lens (`b`) is snapshotted here so the suite carries both. D4 may
 * compact these strings — this is the baseline copy.
 */
export const PLAN_LENSES = {
  a: 'completeness: is every element of the original ask covered by some deliverable? Hunt for missing requirements, unhandled edge cases, acceptance criteria without tests, and parts of the ask that silently disappeared',
  b: 'soundness: wrong assumptions about the codebase, DAG dependency errors (missing or backwards deps, undeclared cross-deliverable coupling), deliverables that mix unrelated themes or whose estimated meaningful diff (excluding generated code, dependency bumps, and fixtures) exceeds ~1,000 lines and should be split, deliverables/chains that should be CONSOLIDATED (fragments of one theme, or a linear chain whose combined meaningful diff — excluding generated code, dependency bumps, and fixtures — is under the ~1,000-line threshold and could be a single deliverable/PR), planned work that is dead, duplicated, or superseded within the plan (steps or files a later step obviates, two deliverables doing the same work, or acceptance criteria/tests no remaining step produces), and steps that cannot work as written',
} as const

/** A fixture assigned-rule block (`ruleBlock(rules)` output) for the reviewer prompt. */
export const FIXTURE_RULE_BLOCK = '- CM-1 (CLAUDE.md): every new user-facing feature ships with a test that exercises it'
/** The rule ids the reviewer must return a checklist verdict for. */
export const FIXTURE_RULE_IDS = 'CM-1'
