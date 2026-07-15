// Harness eval case: the IMPLEMENTER prompt.
//
// The `prompt` is a baseline snapshot copied verbatim from the non-addendum
// branch of `implementPrompt` in `src/workflows/strapped-run/stages/implement.ts`,
// with the runtime `${item.*}`/`${cfg.*}` holes filled by fixture WaveItem values.
// A single-shot, tool-free eval cannot actually implement + validate on disk, so
// this case grades the SHAPE of the returned `ImplementResult` (a valid status
// enum, a boolean `validations_green`, and status/green/blocker consistency) —
// the contract every implementer completion must honor.
// D4 may compact this text and A/B the candidate against this baseline.

import { defineCase } from '../../case.ts'
import { assert, schemaConforms } from '../../grade.ts'
import { IMPLEMENT_SCHEMA } from '../../../workflows/strapped-run/schemas.generated.ts'
import { asSchema, FIXTURE_DIR, FIXTURE_SLUG, STRAPPED_CONTEXT } from './fixtures/context.ts'

/** Parsed implementer output shape (mirrors `ImplementResult`). */
interface ImplementOutput {
  status?: unknown
  validations_green?: unknown
  blocker?: unknown
}

// Fixture WaveItem values the implement prompt interpolates.
const ITEM_ID = 'D1'
const ITEM_WORKTREE = '/home/user/strapped__worktrees/eval-fixture/D1-dry-run-resolver'
const ITEM_BRANCH = 'strapped/eval-fixture/D1-dry-run-resolver'
const ITEM_BASE = 'main'
const ITEM_REPO = 'strapped'
const ITEM_REPO_ROOT = '/home/user/strapped'
const ITEM_PLAN_FILE = `${FIXTURE_DIR}/deliverables/D1-dry-run-resolver.md`
const ITEM_VALIDATIONS = ['bun run typecheck', 'bun run lint', 'bun test']

// Baseline implementer prompt, verbatim from the pre-D4 non-addendum branch of
// `implementPrompt`: filler lead-in ("You have fresh context — everything you
// need is in the files below."), a verbose read-list item 3, and a doubled
// "commit" in the closing paragraph.
const IMPLEMENTER_BASELINE = `You are the implementation agent for deliverable ${ITEM_ID} of strapped run "${FIXTURE_SLUG}". You have fresh context — everything you need is in the files below.

Work EXCLUSIVELY inside the worktree: ${ITEM_WORKTREE} (branch ${ITEM_BRANCH}, based on ${ITEM_BASE}). This deliverable targets repo "${ITEM_REPO}" — never touch ${ITEM_REPO_ROOT} directly.

1. Read your deliverable plan in full: ${ITEM_PLAN_FILE}
2. Read the shared research digest: ${FIXTURE_DIR}/research.md
3. Read the project guidelines: every CLAUDE.md that applies (repo root at minimum).

Implement exactly what the plan specifies — its acceptance criteria are the contract. Write the tests the plan names (integration-style, public interfaces). Stay in scope: anything under "Out of scope" is off limits; note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${ITEM_VALIDATIONS.map(v => `- ${v}`).join('\n')}

Commit your work on ${ITEM_BRANCH} with a Conventional-Commits message (\`<type>(${FIXTURE_SLUG}): <description>\` — scope is the run slug, no \`${ITEM_ID}:\` title prefix; reference ${ITEM_ID} in the body). If validations pass, commit and return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (missing dependency, contradictory plan, validation failure you cannot fix), commit what is safe, return status "blocked" with the blocker described — do NOT loop indefinitely.`

// Candidate implementer prompt: filler lead-in folded into the header, read-list
// item 3 tightened, and the doubled "commit" removed. Mirrors the compacted live
// stage source.
const IMPLEMENTER_CANDIDATE = `You are the implementation agent for deliverable ${ITEM_ID} of strapped run "${FIXTURE_SLUG}" — fresh context; everything you need is below.

Work EXCLUSIVELY inside the worktree ${ITEM_WORKTREE} (branch ${ITEM_BRANCH}, based on ${ITEM_BASE}). This deliverable targets repo "${ITEM_REPO}" — never touch ${ITEM_REPO_ROOT} directly.

1. Read your deliverable plan in full: ${ITEM_PLAN_FILE}
2. Read the shared research digest: ${FIXTURE_DIR}/research.md
3. Read every applicable CLAUDE.md (repo root at minimum).

Implement exactly what the plan specifies — its acceptance criteria are the contract. Write the tests the plan names (integration-style, public interfaces). Stay in scope: anything under "Out of scope" is off limits; note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${ITEM_VALIDATIONS.map(v => `- ${v}`).join('\n')}

Commit on ${ITEM_BRANCH} with a Conventional-Commits message (\`<type>(${FIXTURE_SLUG}): <description>\` — scope is the run slug, no \`${ITEM_ID}:\` title prefix; reference ${ITEM_ID} in the body). If validations pass, return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (missing dependency, contradictory plan, an unfixable validation failure), commit what is safe and return status "blocked" with the blocker described — do NOT loop indefinitely.`

export const implementerCase = defineCase({
  id: 'implementer',
  tags: ['implementer'],
  appendSystemPrompt: STRAPPED_CONTEXT,
  // `prompt` tracks the LIVE (compacted) stage source; `variants` records the
  // baseline→candidate A/B this deliverable verified (`bun run eval --ab`).
  prompt: IMPLEMENTER_CANDIDATE,
  variants: {
    baseline: { label: 'baseline', prompt: IMPLEMENTER_BASELINE },
    candidate: { label: 'compacted', prompt: IMPLEMENTER_CANDIDATE },
  },
  schema: asSchema(IMPLEMENT_SCHEMA),
  graders: [
    schemaConforms(),
    assert('valid-status', o => {
      const s = (o as ImplementOutput).status
      return s === 'implemented' || s === 'blocked'
    }),
    assert('validations-green-boolean', o => typeof (o as ImplementOutput).validations_green === 'boolean'),
    // Discriminator: an "implemented" verdict is only coherent when validations
    // actually went green — a self-inconsistent envelope must not pass.
    assert('implemented-implies-green', o => {
      const out = o as ImplementOutput
      return out.status !== 'implemented' || out.validations_green === true
    }),
  ],
})
