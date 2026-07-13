// One adversarial code-review round for one deliverable: 2 rule-partitioned
// reviewers, per-finding refute pass, dedup-vs-seen consolidation writing
// reviews/<id>-code-round-<N><suffix>.md.

import { rulesForRound } from '../config.ts'
import { digest, ruleBlock } from '../review-loop.ts'
import { CONSOLIDATE_SCHEMA, FINDINGS_SCHEMA, REFUTE_SCHEMA } from '../schemas.ts'
import type {
  CodeFinding,
  ConsolidateResult,
  FindingsResult,
  RefuteResult,
  Refuted,
  ReviewerId,
  RunConfig,
  SeenFinding,
  WaveItem,
} from '../types.ts'

export const CODE_LENSES: Record<ReviewerId, string> = {
  a: 'correctness: logic bugs, unhandled edge cases, race conditions, broken error paths, and acceptance-criteria compliance',
  b: 'convention and test fidelity: adherence to the assigned guidelines, and test quality — integration-style tests of public interfaces, no mocking, aiohttp test servers for network, polyfactory for stubs',
}

export interface CodeReviewRoundOpts {
  item: WaveItem
  round: number
  confirmation: boolean
  seen: readonly SeenFinding[]
  recordSuffix: string
}

export interface CodeReviewRoundResult {
  newConfirmed: Array<Refuted<CodeFinding>>
  suggestions: CodeFinding[]
  roundFile: string
  converged: boolean
}

export async function runCodeReviewRound(
  cfg: RunConfig,
  { item, round, confirmation, seen, recordSuffix }: CodeReviewRoundOpts
): Promise<CodeReviewRoundResult> {
  const rules = rulesForRound(cfg, round)
  const roundLabel = confirmation ? `${round}-confirm` : `${round}`
  const seedUsed = cfg.seed + round
  const seenDigest = seen.length ? digest(seen) : ''

  function reviewerPrompt(which: ReviewerId): string {
    return `You are an adversarial code reviewer with fresh context. Review exactly one deliverable's implementation.

Deliverable: ${item.id} of strapped run "${cfg.slug}".
Worktree (the code under review lives here): ${item.worktree}${item.repo ? `\nTarget repo: ${item.repo}${item.repoRoot ? ` (root ${item.repoRoot})` : ''}` : ''}
Branch: ${item.branch}   Base: ${item.base}

Procedure:
1. Read the deliverable plan at ${item.planFile} — its acceptance criteria define what the code must do.
2. In the worktree, run: git diff ${item.base}...${item.branch}
3. Read every touched file in full in the worktree, plus any callers or tests you need for context.
${item.validations && item.validations.length ? `\nThis repo's validations (must be green for the deliverable — assume the implementer ran them; flag any code that would break one):\n${item.validations.map(v => `- ${v}`).join('\n')}\n` : ''}
Your lens (your main hunting ground beyond the rules): ${CODE_LENSES[which]}.

Your assigned guideline rules — you are the ONLY reviewer checking these, so check every one explicitly:
${ruleBlock(rules[which])}

Known findings from earlier rounds — do NOT re-report these unless the code has regressed:
${seenDigest || '(none — first round)'}

Report only real, evidenced issues. Severity: "blocking" = bug or guideline violation that must be fixed; "concern" = likely problem needing a fix or justification; "suggestion" = optional polish (never drives rework). For each finding give a stable key "<rule-id-or-gap>:<file-or-location>". Set confidence honestly — findings under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist entry with a pass/violation/na verdict and one line of evidence for every assigned rule (${rules[which].map(r => r.id).join(', ')}), plus your findings.`
  }

  function refutePrompt(f: CodeFinding): string {
    return `You are a skeptical verifier with fresh context. A code reviewer claims the following issue in deliverable ${item.id} (worktree: ${item.worktree}, diff: git diff ${item.base}...${item.branch}).

Claim [${f.severity}] at ${f.location}: ${f.what}
Why the reviewer thinks so: ${f.why}
Their evidence: ${f.evidence}

Your stance: this is NOT a real issue unless the code proves otherwise. Read the actual code in the worktree and try to refute the claim — look for handling the reviewer missed, misread control flow, or a claim about code that does not exist. Return your verdict, a corrected confidence (0-100) that the issue is real, and one line of evidence.`
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

  const gating = allFindings.filter(f => f.severity !== 'suggestion')
  const suggestions = allFindings.filter(f => f.severity === 'suggestion')
  log(`${item.id} round ${roundLabel}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

  const verified = await parallel(
    gating.map(f => () =>
      agent<RefuteResult>(refutePrompt(f), { label: `refute:${item.id}:${f.id}`, phase: 'Verify', effort: 'low', schema: REFUTE_SCHEMA })
        .then(v => ({ ...f, refute: v }))
    )
  )
  // Null refuter result = vote not cast; never dereferenced, never surviving.
  const surviving = verified
    .filter(Boolean)
    .filter(f => f.refute && f.refute.verdict !== 'refuted' && f.refute.confidence >= cfg.confidenceMin)
  const dropped = gating.length - surviving.length
  if (dropped > 0) log(`${item.id} round ${roundLabel}: refute pass dropped ${dropped} finding(s)`)

  const roundFile = `${cfg.dir}/reviews/${item.id}-code-round-${roundLabel}${recordSuffix}.md`
  const consolidation = await agent<ConsolidateResult>(
    `You are consolidating verified code-review findings for deliverable ${item.id}, round ${roundLabel}, of strapped run "${cfg.slug}". Follow the round-record format in ${cfg.conventionsFile}.

Surviving verified findings (already passed the refute filter):
${JSON.stringify(surviving, null, 2)}

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

Seen digest from prior rounds:
${seenDigest || '(none — first round)'}

Prior round record files, if any, live in ${cfg.dir}/reviews/ named ${item.id}-code-round-*${recordSuffix}.md — read them.

Tasks:
1. Merge same-root-cause findings by key against BOTH this round's set and all prior rounds. A finding matching a prior round's key is a duplicate unless the prior record marks it fixed and it has regressed.
2. Write the round record to ${roundFile} with frontmatter: round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a.map(r => r.id))}, reviewer_b_rules: ${JSON.stringify(rules.b.map(r => r.id))}, new_confirmed: <count>, outcome: converged if zero new confirmed else revise, and the findings list (status: open for new confirmed, duplicate for duplicates). Body: full finding bodies (what/why/evidence/recommendation) plus the two rule checklists.
3. Return the ids of truly-NEW confirmed findings and the ids of duplicates.`,
    { label: `consolidate:${item.id}:r${roundLabel}`, phase: 'Consolidate', effort: 'low', schema: CONSOLIDATE_SCHEMA }
  )

  const newIds = new Set(consolidation ? consolidation.new_confirmed_ids : surviving.map(f => f.id))
  const newConfirmed = surviving.filter(f => newIds.has(f.id))
  log(`${item.id} round ${roundLabel}: ${newConfirmed.length} NEW confirmed finding(s)`)

  return { newConfirmed, suggestions, roundFile, converged: newConfirmed.length === 0 }
}
