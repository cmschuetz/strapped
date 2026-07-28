// Harness eval case: the REFUTER prompt.
//
// The `prompt` is a baseline snapshot copied verbatim from `refutePrompt` in
// `src/workflows/strapped-run/review-loop.ts`, with the runtime `${...}` holes
// filled by fixture constants and the fixture plan embedded inline (a single-shot
// eval has no filesystem to read the artifact files from). The finding under
// scrutiny is deliberately weak — the plan names the resolver's file explicitly —
// so a skeptical refuter should return `verdict: 'refuted'`.
// D4 may compact this text and A/B the candidate against this baseline.

import { defineCase } from '../../case.ts'
import { assert, schemaConforms } from '../../grade.ts'
import { REFUTE_SCHEMA } from '../../../workflows/strapped-run/schemas.generated.ts'
import { asSchema, FIXTURE_DIR, FIXTURE_REPOS, STRAPPED_CONTEXT } from './fixtures/context.ts'
import { FIXTURE_SOURCE_PLAN } from './fixtures/source-plan.ts'
import { SEEDED_GAP_PLAN } from './fixtures/seeded-gap-plan.ts'
import { WEAK_FINDING } from './fixtures/weak-finding.ts'

/** Parsed refuter output shape (mirrors `RefuteResult`). */
interface RefuteOutput {
  verdict?: unknown
}

const REFUTER_PROMPT = `You are a skeptical verifier with fresh context. A plan reviewer claims the following gap in the implementation plan at ${FIXTURE_DIR} (original ask: ${FIXTURE_SOURCE_PLAN}). Target repos you may explore to check the claim:
${FIXTURE_REPOS}

Claim [${WEAK_FINDING.severity}] at ${WEAK_FINDING.location}: ${WEAK_FINDING.what}
Why: ${WEAK_FINDING.why}
Evidence: ${WEAK_FINDING.evidence}

Your stance: this is NOT a real gap unless the documents prove otherwise. Read the ask and the plan files yourself — the claimed-missing item may be covered elsewhere in the plan, the assumption may actually hold in the codebase, or the claim may misread the ask. Return your verdict, a corrected confidence (0-100) that the gap is real, and one line of evidence.

--- Plan under review (inlined for this single-shot eval; the files above are provided here verbatim) ---
${SEEDED_GAP_PLAN}`

export const refuterCase = defineCase({
  id: 'refuter',
  tags: ['refuter'],
  appendSystemPrompt: STRAPPED_CONTEXT,
  prompt: REFUTER_PROMPT,
  schema: asSchema(REFUTE_SCHEMA),
  graders: [
    schemaConforms(),
    // Discriminator: the finding is not real (the plan's "Files to touch" names
    // resolver.ts), so the correct verdict is `refuted`.
    assert('verdict-refuted', o => (o as RefuteOutput).verdict === 'refuted'),
  ],
})
