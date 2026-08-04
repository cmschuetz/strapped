// Harness eval case: the VERIFY-CONSOLIDATE prompt.
//
// The `prompt` is a baseline snapshot copied verbatim from the verify prompt in
// `src/workflows/strapped-run/review-loop.ts`, with the runtime `${...}` holes
// filled by fixture constants and the fixture plan embedded inline (a single-shot
// eval has no filesystem to read the artifact files from, so the record-writing
// consolidation task cannot execute — the graders check only the returned JSON
// verdicts). The single gating finding under scrutiny is deliberately weak —
// the plan names the resolver's file explicitly — so a skeptical verifier should
// return `verdict: 'refuted'` for it and confirm nothing.
// D4 may compact this text and A/B the candidate against this baseline.

import { defineCase } from '../../case.ts'
import { assert, schemaConforms } from '../../grade.ts'
import { VERIFY_SCHEMA } from '../../../workflows/strapped-run/schemas.generated.ts'
import {
  asSchema,
  FIXTURE_CONFIDENCE_MIN,
  FIXTURE_CONVENTIONS,
  FIXTURE_DIR,
  FIXTURE_REPOS,
  FIXTURE_RULES_FILE,
  FIXTURE_SEED,
  FIXTURE_SLUG,
  STRAPPED_CONTEXT,
} from './fixtures/context.ts'
import { FIXTURE_SOURCE_PLAN } from './fixtures/source-plan.ts'
import { SEEDED_GAP_PLAN } from './fixtures/seeded-gap-plan.ts'
import { WEAK_FINDING } from './fixtures/weak-finding.ts'

/** The weak finding shaped as the workflow's round-tagged gating finding. */
const WEAK_GATING_FINDING = {
  id: 'r1-a-f1',
  key: `gap:${WEAK_FINDING.location}`,
  rule: null,
  severity: WEAK_FINDING.severity,
  location: WEAK_FINDING.location,
  what: WEAK_FINDING.what,
  why: WEAK_FINDING.why,
  evidence: WEAK_FINDING.evidence,
  confidence: 80,
  recommendation: 'Name the file the resolver should live in.',
}

/** Parsed verifier output shape (mirrors `VerifyResult`). */
interface VerifyOutput {
  verdicts?: Array<{ id?: unknown; verdict?: unknown }>
  new_confirmed_ids?: unknown
}

const ROUND_FILE = `${FIXTURE_DIR}/reviews/plan-round-1.md`

const VERIFIER_PROMPT = `You are the verify-consolidate agent for round 1 of strapped run "${FIXTURE_SLUG}": a skeptical verifier adjudicating EVERY gating finding in one batch pass, then the round's consolidator writing its record. Round-record format: ${FIXTURE_CONVENTIONS}.

Plan reviewers claim the following gaps in the implementation plan at ${FIXTURE_DIR} (original ask: ${FIXTURE_SOURCE_PLAN}). Target repos you may explore to check each claim:
${FIXTURE_REPOS}

The guideline rules behind rule-keyed findings and the checklists carry only their ids here — the verbatim rule text lives in the rules snapshot at ${FIXTURE_RULES_FILE}; Read it whenever a rule's wording matters to a verdict.

Gating findings to adjudicate:
${JSON.stringify([WEAK_GATING_FINDING], null, 2)}

Verification stance, applied to each finding independently: it is NOT a real gap unless the documents prove otherwise. Read the ask and the plan files yourself — a claimed-missing item may be covered elsewhere in the plan, the assumption may actually hold in the codebase, or the claim may misread the ask. Cast one verdict per finding id — "confirmed" (the gap is proven real), "plausible" (credible but unproven), or "refuted" (not a real gap) — with a corrected confidence (0-100) that the gap is real and one line of evidence. A finding with verdict refuted, or confidence below ${FIXTURE_CONFIDENCE_MIN}, does not survive.

Suggestions (non-gating, never verified, record only):
[]

Rule checklists: {}

AC/addendum checklists (per-item AC pass/violation/na verdicts from each reviewer): {}

Seen digest from prior rounds:
(none — first round)

Prior round files live at ${FIXTURE_DIR}/reviews/plan-round-*.md — read them.

Consolidation tasks, over the findings that survive your verdicts:
1. Merge same-root-cause findings by key against this round's set and all prior rounds; a match on a prior key is a duplicate unless the prior record marks it fixed and the revision regressed.
2. Write ${ROUND_FILE} with frontmatter (round: 1, seed_used: ${FIXTURE_SEED + 1}, reviewer_a_rules: ["R1"], reviewer_b_rules: ["R2"], new_confirmed: <count>, outcome: converged if zero new confirmed else revise, findings list) and full finding bodies — EACH carrying your per-finding verdict line (verdict: confirmed|plausible|refuted, confidence, one-line evidence) — plus both rule checklists AND both AC/addendum checklists (the per-item AC pass/violation/na verdicts).
3. Return your per-finding verdicts, the ids of truly-NEW confirmed findings (surviving and not duplicates), and the duplicate ids.

--- Plan under review (inlined for this single-shot eval; the files above are provided here verbatim) ---
${SEEDED_GAP_PLAN}`

export const verifierCase = defineCase({
  id: 'verifier',
  tags: ['verifier'],
  appendSystemPrompt: STRAPPED_CONTEXT,
  prompt: VERIFIER_PROMPT,
  schema: asSchema(VERIFY_SCHEMA),
  graders: [
    schemaConforms(),
    // Discriminator: the finding is not real (the plan's "Files to touch" names
    // resolver.ts), so its per-finding verdict must be `refuted`…
    assert('weak-finding-refuted', o => {
      const out = o as VerifyOutput
      return Array.isArray(out.verdicts) && out.verdicts.some(v => v.id === 'r1-a-f1' && v.verdict === 'refuted')
    }),
    // …and a refuted finding can never surface as a NEW confirmed id.
    assert('nothing-confirmed', o => {
      const ids = (o as VerifyOutput).new_confirmed_ids
      return Array.isArray(ids) && !ids.includes('r1-a-f1')
    }),
  ],
})
