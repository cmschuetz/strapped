// One adversarial code-review round for one deliverable: 2 rule-partitioned
// reviewers, then ONE verify-consolidate agent (batch skeptical verification of
// every gating finding + dedup-vs-seen consolidation) writing
// reviews/<id>-code-round-<N><suffix>.md.

import { rulesFileFor, rulesForRound } from '../config.ts'
import { digest } from '../review-loop.ts'
import { FINDINGS_SCHEMA, VERIFY_SCHEMA } from '../schemas.generated.ts'
import type {
  CodeFinding,
  FindingsResult,
  ReviewerId,
  RunConfig,
  SeenFinding,
  VerifyResult,
  WaveItem,
} from '../types.ts'

export const CODE_LENSES: Record<ReviewerId, string> = {
  a: 'correctness: logic bugs, unhandled edge cases, race conditions, broken error paths, and acceptance-criteria compliance',
  b: 'convention and test fidelity plus dead-code hygiene: adherence to the assigned guidelines, and test quality — integration-style tests of public interfaces, no mocking, aiohttp test servers for network, polyfactory for stubs; AND dead/duplicated/superseded code — leftover or unreachable code, tests or fixtures orphaned by a changed idea (kept after the code they covered was rewritten or removed), and code no acceptance criterion or addendum task needs',
}

export interface CodeReviewRoundOpts {
  item: WaveItem
  round: number
  confirmation: boolean
  seen: readonly SeenFinding[]
  recordSuffix: string
}

export interface CodeReviewRoundResult {
  newConfirmed: CodeFinding[]
  suggestions: CodeFinding[]
  roundFile: string
  converged: boolean
}

export async function runCodeReviewRound(
  cfg: RunConfig,
  { item, round, confirmation, seen, recordSuffix }: CodeReviewRoundOpts
): Promise<CodeReviewRoundResult> {
  const rules = rulesForRound(cfg, round)
  const rulesFile = rulesFileFor(cfg)
  const roundLabel = confirmation ? `${round}-confirm` : `${round}`
  const seedUsed = cfg.seed + round
  const seenDigest = seen.length ? digest(seen) : ''

  function reviewerPrompt(which: ReviewerId): string {
    return `You are an adversarial code reviewer with fresh context. Review exactly one deliverable's implementation.

Deliverable: ${item.id} of strapped run "${cfg.slug}".
Worktree (the code under review lives here): ${item.worktree}${item.repo ? `\nTarget repo: ${item.repo}${item.repoRoot ? ` (root ${item.repoRoot})` : ''}` : ''}
Branch: ${item.branch}   Base: ${item.base}

Procedure:
1. Read the rules snapshot at ${rulesFile} for the verbatim text of your assigned guideline rules (${rules[which].join(', ')}) — the workflow args carry only their ids; each rule is a \`- <id> (<source>): <text>\` line, and the ids not assigned to you are the other reviewer's.
2. Read the deliverable plan at ${item.planFile} — its acceptance criteria define what the code must do. Enumerate every item under its \`## Acceptance criteria\` as AC1..ACn — and, if the plan ALSO carries a \`## Feedback addendum\` section, every addendum task under it too, continuing the numbering — and return one ac_checklist entry per item ({ id: "AC<k>", verdict: pass|violation|na, evidence: one line pointing at the code/test that satisfies or fails it }). An AC or addendum item the CODE fails to satisfy or leaves untested is a BLOCKING finding. This checks the actual code, not just the plan. A plan with neither section → \`ac_checklist: []\`.
3. In the worktree, run: git diff ${item.base}...${item.branch}
4. Read every touched file in full in the worktree, plus any callers or tests you need for context.
${item.validations && item.validations.length ? `\nThis repo's validations (must be green for the deliverable — assume the implementer ran them; flag any code that would break one):\n${item.validations.map(v => `- ${v}`).join('\n')}\n` : ''}
Your lens (your main hunting ground beyond the rules): ${CODE_LENSES[which]}.

Your assigned guideline rules — you are the ONLY reviewer checking these, so check every one explicitly: ${rules[which].join(', ')} (verbatim text in the rules snapshot from step 1).

Known findings from earlier rounds — do NOT re-report these unless the code has regressed:
${seenDigest || '(none — first round)'}

Report only real, evidenced issues. Severity: "blocking" = bug or guideline violation that must be fixed; "concern" = likely problem needing a fix or justification; "suggestion" = optional polish (never drives rework). For each finding give a stable key "<rule-id-or-gap>:<file-or-location>". Set confidence honestly — findings under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist entry with a pass/violation/na verdict and one line of evidence for every assigned rule (${rules[which].join(', ')}), the ac_checklist covering every AC (and addendum task) from step 2, plus your findings.`
  }

  const reviews = await parallel([
    () => agent<FindingsResult>(reviewerPrompt('a'), { label: `review:${item.id}:a:r${roundLabel}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
    () => agent<FindingsResult>(reviewerPrompt('b'), { label: `review:${item.id}:b:r${roundLabel}`, phase: 'Review', schema: FINDINGS_SCHEMA }),
  ])

  const tagged = reviews
    .map((r, i) => ({ r, which: i === 0 ? ('a' as const) : ('b' as const) }))
    .filter((x): x is { r: FindingsResult; which: ReviewerId } => Boolean(x.r))
  const allFindings = tagged.flatMap(x =>
    x.r.findings.map(f => ({ ...f, id: `r${roundLabel}-${x.which}-${f.id}`, reviewer: x.which }))
  )
  const checklists = Object.fromEntries(tagged.map(x => [x.which, x.r.rule_checklist] as const))
  const acChecklists = Object.fromEntries(tagged.map(x => [x.which, x.r.ac_checklist] as const))

  const gating = allFindings.filter(f => f.severity !== 'suggestion')
  const suggestions = allFindings.filter(f => f.severity === 'suggestion')
  log(`${item.id} round ${roundLabel}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

  const roundFile = `${cfg.dir}/reviews/${item.id}-code-round-${roundLabel}${recordSuffix}.md`
  // Zero gating findings → record-writer fast path; see review-loop.ts.
  const verification = await agent<VerifyResult>(
    gating.length === 0
      ? `You are the record-writer for deliverable ${item.id}, code-review round ${roundLabel}, of strapped run "${cfg.slug}". This round is CLEAN: the reviewers returned zero gating findings, so there is nothing to adjudicate and nothing to dedup. Do NOT re-review the code and do NOT read the worktree — your only job is the round record. Round-record format: ${cfg.conventionsFile}.

Write the round record to ${roundFile} with frontmatter: round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a)}, reviewer_b_rules: ${JSON.stringify(rules.b)}, new_confirmed: 0, outcome: converged, findings list = the suggestions below with status suggestion. Body: the suggestions plus the two rule checklists AND the two AC/addendum checklists verbatim.

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

AC/addendum checklists: ${JSON.stringify(acChecklists, null, 2)}

Return empty verdicts, empty new-confirmed ids, and empty duplicate ids.`
      : `You are the verify-consolidate agent for deliverable ${item.id}, code-review round ${roundLabel}, of strapped run "${cfg.slug}": a skeptical verifier adjudicating EVERY gating finding in one batch pass, then the round's consolidator writing its record. Round-record format: ${cfg.conventionsFile}.${confirmation ? '\nThis is a CONFIRMATION pass after the final budgeted round: its findings were all fixed, and this pass re-checks whether any NEW issue remains.' : ''}

Code reviewers claim the following issues in deliverable ${item.id} (worktree: ${item.worktree}, diff: git diff ${item.base}...${item.branch}).

The guideline rules behind rule-keyed findings and the checklists carry only their ids here — the verbatim rule text lives in the rules snapshot at ${rulesFile}; Read it whenever a rule's wording matters to a verdict.

Gating findings to adjudicate:
${JSON.stringify(gating, null, 2)}

Verification stance, applied to each finding independently: it is NOT a real issue unless the code proves otherwise. Read the actual code in the worktree and try to refute each claim — look for handling the reviewer missed, misread control flow, or a claim about code that does not exist. Cast one verdict per finding id — "confirmed" (the issue is proven real), "plausible" (credible but unproven), or "refuted" (not a real issue) — with a corrected confidence (0-100) that the issue is real and one line of evidence. A finding with verdict refuted, or confidence below ${cfg.confidenceMin}, does not survive.

Suggestions (non-gating, never verified, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

AC/addendum checklists (per-item AC pass/violation/na verdicts from each reviewer, enumerating the deliverable plan's \`## Acceptance criteria\` plus any \`## Feedback addendum\` tasks): ${JSON.stringify(acChecklists, null, 2)}

Seen digest from prior rounds:
${seenDigest || '(none — first round)'}

Prior round record files, if any, live in ${cfg.dir}/reviews/ named ${item.id}-code-round-*${recordSuffix}.md — read them.

Consolidation tasks, over the findings that survive your verdicts:
1. Merge same-root-cause findings by key against BOTH this round's set and all prior rounds. A finding matching a prior round's key is a duplicate unless the prior record marks it fixed and it has regressed.
2. Write the round record to ${roundFile} with frontmatter: round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a)}, reviewer_b_rules: ${JSON.stringify(rules.b)}, new_confirmed: <count>, outcome: converged if zero new confirmed else revise, and the findings list (status: open for new confirmed, duplicate for duplicates). Body: full finding bodies (what/why/evidence/recommendation) plus the two rule checklists AND the two AC/addendum checklists (the per-item AC/addendum pass/violation/na verdicts).
3. Return your per-finding verdicts, the ids of truly-NEW confirmed findings (surviving and not duplicates), and the duplicate ids.`,
    { label: `verify:${item.id}:r${roundLabel}`, phase: 'Verify', effort: 'low', schema: VERIFY_SCHEMA }
  )

  // A null verifier result is a vote NOT cast on every finding — never
  // dereferenced, and a finding without a cast confirming vote never survives.
  if (!verification) {
    if (gating.length) log(`${item.id} round ${roundLabel}: verifier cast no vote — ${gating.length} gating finding(s) excluded`)
    return { newConfirmed: [], suggestions, roundFile, converged: true }
  }
  const verdictById = new Map(verification.verdicts.map(v => [v.id, v] as const))
  const surviving = gating.filter(f => {
    const v = verdictById.get(f.id)
    return v !== undefined && v.verdict !== 'refuted' && v.confidence >= cfg.confidenceMin
  })
  const dropped = gating.length - surviving.length
  if (dropped > 0) log(`${item.id} round ${roundLabel}: verify pass dropped ${dropped} finding(s)`)

  const newIds = new Set(verification.new_confirmed_ids)
  const newConfirmed = surviving.filter(f => newIds.has(f.id))
  log(`${item.id} round ${roundLabel}: ${newConfirmed.length} NEW confirmed finding(s)`)

  return { newConfirmed, suggestions, roundFile, converged: newConfirmed.length === 0 }
}
