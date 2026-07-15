// Harness eval case: the plan REVIEWER prompt.
//
// The `prompt` is a baseline snapshot copied verbatim from `reviewerPrompt` in
// `src/workflows/strapped-run/review-loop.ts` (the completeness lens `a`, which is
// the one that catches an acceptance-criterion with no test), with the runtime
// `${...}` holes filled by fixture constants. Both `PLAN_LENSES` are snapshotted
// in `fixtures/context.ts`. The fixture plan under review is embedded inline
// because a single-shot eval has no filesystem to read the artifact files from.
// D4 may compact this text and A/B the candidate against this baseline.

import { defineCase } from '../../case.ts'
import { assert, schemaConforms } from '../../grade.ts'
import { FINDINGS_SCHEMA } from '../../../workflows/strapped-run/schemas.generated.ts'
import {
  asSchema,
  FIXTURE_CONVENTIONS,
  FIXTURE_CONFIDENCE_MIN,
  FIXTURE_DIR,
  FIXTURE_REPOS,
  FIXTURE_RULE_BLOCK,
  FIXTURE_RULE_IDS,
  PLAN_LENSES,
  STRAPPED_CONTEXT,
} from './fixtures/context.ts'
import { FIXTURE_SOURCE_PLAN } from './fixtures/source-plan.ts'
import { SEEDED_GAP_PLAN } from './fixtures/seeded-gap-plan.ts'

/** Parsed reviewer output shape (mirrors `FindingsResult`). */
interface FindingsOutput {
  findings?: Array<{ severity?: unknown; what?: unknown }>
  ac_checklist?: Array<{ id?: unknown; verdict?: unknown }>
}

/** Shared reviewer prompt scaffold — the AC-checklist paragraph is the hot-spot. */
function reviewerPrompt(acChecklistParagraph: string): string {
  return `You are an adversarial plan reviewer with fresh context. Your job is to find real gaps between a produced implementation plan and the original ask, before any code is written.

Original ask: ${FIXTURE_SOURCE_PLAN}
Plan under review, in ${FIXTURE_DIR}: manifest.md, research.md, and every file in deliverables/.
Conventions the plan must follow: ${FIXTURE_CONVENTIONS}
Target repos (explore any of these as needed to check the plan's claims against reality):
${FIXTURE_REPOS}

Read the original ask first, then the whole plan, then verify claims against the actual codebase(s) where they matter.

Your lens (your main hunting ground beyond the rules): ${PLAN_LENSES.a}.
Your assigned guideline rules — you are the ONLY reviewer checking the plan against these, so check every one explicitly (does the plan instruct or imply work that would violate the rule?):
${FIXTURE_RULE_BLOCK}

Known findings from earlier rounds — do NOT re-report unless the revision failed to address them:
(none — first round)

${acChecklistParagraph}

Severity: "blocking" = the plan as written produces wrong or missing work; "concern" = likely gap needing a fix or an explicit justification; "suggestion" = optional polish (never drives revision). Stable key format "<rule-id-or-gap>:<plan-location>". Confidence under ${FIXTURE_CONFIDENCE_MIN} will be dropped.

You MUST return a rule_checklist verdict (pass/violation/na + one line of evidence) for every assigned rule (${FIXTURE_RULE_IDS}), the ac_checklist covering every AC item, plus your findings. Round: 1.

--- Artifact under review (inlined for this single-shot eval; the files above are provided here verbatim) ---
${SEEDED_GAP_PLAN}`
}

// Baseline AC-checklist paragraph, verbatim from the pre-D4 reviewer prompt: it
// states the equal-weight point twice ("carrying full guideline-rule weight" AND
// "as load-bearing as the rule checklist").
const BASELINE_AC = `Enumerated AC checklist — you and the other reviewer BOTH return this every round (it is NOT partitioned like the guideline rules): read EVERY artifact file's \`## Acceptance criteria\` section, enumerate each item in order as AC1..ACn across the whole artifact, and return one ac_checklist entry per item ({ id: "AC<k>", verdict: pass|violation|na, evidence: one line }). An item the plan fails to satisfy, or that no step/test covers, is a BLOCKING finding carrying full guideline-rule weight — enumerating and checking these items is as load-bearing as the rule checklist. If no file has a \`## Acceptance criteria\` section, return \`ac_checklist: []\`.`

// Candidate AC-checklist paragraph: the doubled equal-weight clause collapsed to
// one. Mirrors the compacted live `review-loop.ts` shared reviewer prompt.
const CANDIDATE_AC = `Enumerated AC checklist — you and the other reviewer BOTH return this every round (it is NOT partitioned like the guideline rules): read EVERY artifact file's \`## Acceptance criteria\` section, enumerate each item in order as AC1..ACn across the whole artifact, and return one ac_checklist entry per item ({ id: "AC<k>", verdict: pass|violation|na, evidence: one line }). An item the plan fails to satisfy, or that no step/test covers, is a BLOCKING finding — checking these is as load-bearing as the rule checklist. If no file has a \`## Acceptance criteria\` section, return \`ac_checklist: []\`.`

const REVIEWER_BASELINE = reviewerPrompt(BASELINE_AC)
const REVIEWER_CANDIDATE = reviewerPrompt(CANDIDATE_AC)

export const reviewerCase = defineCase({
  id: 'reviewer',
  tags: ['reviewer'],
  appendSystemPrompt: STRAPPED_CONTEXT,
  // `prompt` tracks the LIVE (compacted) reviewer source; `variants` records the
  // baseline→candidate A/B this deliverable verified (`bun run eval --ab`).
  prompt: REVIEWER_CANDIDATE,
  variants: {
    baseline: { label: 'baseline', prompt: REVIEWER_BASELINE },
    candidate: { label: 'compacted', prompt: REVIEWER_CANDIDATE },
  },
  schema: asSchema(FINDINGS_SCHEMA),
  graders: [
    schemaConforms(),
    // Discriminator: the seeded gap is an AC (the --dry-run --json mode) with no
    // covering test, plus the dropped docs requirement. A completeness reviewer
    // must surface it — either as a gating finding mentioning the missing
    // test/JSON coverage, or as an `ac_checklist` violation.
    assert('surfaces-seeded-gap', o => {
      const out = o as FindingsOutput
      const findings = Array.isArray(out.findings) ? out.findings : []
      const ac = Array.isArray(out.ac_checklist) ? out.ac_checklist : []
      const gapInFindings = findings.some(f => {
        const what = typeof f.what === 'string' ? f.what.toLowerCase() : ''
        return f.severity !== 'suggestion' && (what.includes('test') || what.includes('json') || what.includes('doc'))
      })
      const gapInAc = ac.some(a => a.verdict === 'violation')
      return gapInFindings || gapInAc
    }),
  ],
})
