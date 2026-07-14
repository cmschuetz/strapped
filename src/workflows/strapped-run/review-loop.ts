// The shared bounded adversarial review loop (plan flow + feedback flow):
// 2 rule-partitioned reviewers, refute pass, dedup-vs-seen consolidation
// writing reviews/<prefix>-round-<N>.md, reviser, final-round confirmation.

import { repoList, rulesForRound } from './config.ts'
import { CONSOLIDATE_SCHEMA, FINDINGS_SCHEMA, REFUTE_SCHEMA } from './schemas.generated.ts'
import type {
  ConsolidateResult,
  Finding,
  FindingsResult,
  RefuteResult,
  Refuted,
  RepoRef,
  ReviewLoopResult,
  ReviewerId,
  Rule,
  RunConfig,
  SeenFinding,
} from './types.ts'

export const PLAN_LENSES: Record<ReviewerId, string> = {
  a: 'completeness: is every element of the original ask covered by some deliverable? Hunt for missing requirements, unhandled edge cases, acceptance criteria without tests, and parts of the ask that silently disappeared',
  b: 'soundness: wrong assumptions about the codebase, DAG dependency errors (missing or backwards deps, undeclared cross-deliverable coupling), deliverables that mix unrelated themes or whose estimated meaningful diff (excluding generated code, dependency bumps, and fixtures) exceeds ~1,000 lines and should be split, deliverables/chains that should be CONSOLIDATED (fragments of one theme, or a linear chain whose combined meaningful diff — excluding generated code, dependency bumps, and fixtures — is under the ~1,000-line threshold and could be a single deliverable/PR), and steps that cannot work as written',
}

export function ruleBlock(rules: readonly Rule[]): string {
  return rules.map(r => `- ${r.id} (${r.source}): ${r.text}`).join('\n')
}

export function digest(seen: readonly SeenFinding[]): string {
  if (!seen.length) return '(none — first round)'
  return seen.map(f => `- [${f.severity}] ${f.key}: ${f.what} (round ${f.round}, ${f.status})`).join('\n')
}

export interface ReviewLoopOpts {
  ask: string | undefined
  repos: readonly RepoRef[] | undefined
  artifactDescription: string
  artifactLocation: string
  artifactNoun: string
  refuteArtifactPhrase: string
  reviserPromptFn: (newConfirmed: Array<Refuted<Finding>>, roundFile: string) => string
  roundFilePrefix: string
  maxRounds: number
}

// Runs the bounded adversarial review loop (2 rule-partitioned reviewers,
// refute pass, dedup-vs-seen consolidation writing reviews/<prefix>-round-<N>.md,
// reviser, final-round confirmation pass) over an ask + an artifact.
export async function runReviewLoop(cfg: RunConfig, opts: ReviewLoopOpts): Promise<ReviewLoopResult> {
  const maxRounds = opts.maxRounds
  const artifactNounCap = opts.artifactNoun.charAt(0).toUpperCase() + opts.artifactNoun.slice(1)

  function reviewerPrompt(which: ReviewerId, rules: readonly Rule[], seen: readonly SeenFinding[], round: number): string {
    return `You are an adversarial plan reviewer with fresh context. Your job is to find real gaps between ${opts.artifactDescription} and the original ask, before any code is written.

Original ask: ${opts.ask}
${artifactNounCap} under review, in ${cfg.dir}: ${opts.artifactLocation}.
Conventions the plan must follow: ${cfg.conventionsFile}
Target repos (explore any of these as needed to check the plan's claims against reality):
${repoList(opts.repos)}

Read the original ask first, then the whole ${opts.artifactNoun}, then verify claims against the actual codebase(s) where they matter.

Your lens (your main hunting ground beyond the rules): ${PLAN_LENSES[which]}.
${which === 'b' ? `\nSoundness — multi-repo checks specific to this run: verify each deliverable has a \`repo:\` field naming one of the target repos above; verify each deliverable's \`base:\` obeys the cross-repo base rule (it is a branch in the SAME repo as the deliverable, or that repo's \`main\` for roots and for cross-repo children — a deliverable can never base on a branch in a different repo); and verify that no cross-repo dep is a true code dependency (cross-repo deps are ordering-only — flag any cross-repo child that would need its parent's unmerged code, since it bases on its own repo's \`main\` and does not have that code).\n` : ''}
Your assigned guideline rules — you are the ONLY reviewer checking the plan against these, so check every one explicitly (does the plan instruct or imply work that would violate the rule?):
${ruleBlock(rules)}

Known findings from earlier rounds — do NOT re-report unless the revision failed to address them:
${digest(seen)}

Severity: "blocking" = the plan as written produces wrong or missing work; "concern" = likely gap needing a fix or an explicit justification; "suggestion" = optional polish (never drives revision). Stable key format "<rule-id-or-gap>:<plan-location>". Confidence under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist verdict (pass/violation/na + one line of evidence) for every assigned rule (${rules.map(r => r.id).join(', ')}), plus your findings. Round: ${round}.`
  }

  function refutePrompt(f: Finding): string {
    return `You are a skeptical verifier with fresh context. A plan reviewer claims the following gap in ${opts.refuteArtifactPhrase} at ${cfg.dir} (original ask: ${opts.ask}). Target repos you may explore to check the claim:
${repoList(opts.repos)}

Claim [${f.severity}] at ${f.location}: ${f.what}
Why: ${f.why}
Evidence: ${f.evidence}

Your stance: this is NOT a real gap unless the documents prove otherwise. Read the ask and the ${opts.artifactNoun} files yourself — the claimed-missing item may be covered elsewhere in the ${opts.artifactNoun}, the assumption may actually hold in the codebase, or the claim may misread the ask. Return your verdict, a corrected confidence (0-100) that the gap is real, and one line of evidence.`
  }

  const seen: SeenFinding[] = []
  let converged = false
  let roundsUsed = 0
  let outstanding: readonly Finding[] = []

  async function runReviewRound(round: number, confirmation: boolean) {
    const rules = rulesForRound(cfg, round)
    const seedUsed = cfg.seed + round
    const roundLabel = confirmation ? `${round}-confirm` : `${round}`
    const phaseLabel = confirmation ? `Confirm ${round}` : `Review ${round}`

    phase(phaseLabel)
    const reviews = await parallel([
      () => agent<FindingsResult>(reviewerPrompt('a', rules.a, seen, round), { label: `plan-review:a:r${roundLabel}`, schema: FINDINGS_SCHEMA }),
      () => agent<FindingsResult>(reviewerPrompt('b', rules.b, seen, round), { label: `plan-review:b:r${roundLabel}`, schema: FINDINGS_SCHEMA }),
    ])

    const tagged = reviews
      .map((r, i) => ({ r, which: i === 0 ? ('a' as const) : ('b' as const) }))
      .filter((x): x is { r: FindingsResult; which: ReviewerId } => Boolean(x.r))
    const allFindings = tagged.flatMap(x => x.r.findings.map(f => ({ ...f, id: `r${roundLabel}-${x.which}-${f.id}` })))
    const checklists = Object.fromEntries(tagged.map(x => [x.which, x.r.rule_checklist] as const))
    const gating = allFindings.filter(f => f.severity !== 'suggestion')
    const suggestions = allFindings.filter(f => f.severity === 'suggestion')
    log(`round ${roundLabel}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

    const verified = await parallel(
      gating.map(f => () =>
        agent<RefuteResult>(refutePrompt(f), { label: `refute:${f.id}`, phase: 'Verify', effort: 'low', schema: REFUTE_SCHEMA })
          .then(v => ({ ...f, refute: v }))
      )
    )
    // A null refuter result is a vote NOT cast — never dereferenced, and a
    // finding without a cast confirming vote does not survive.
    const noVote = verified.filter(f => f && !f.refute)
    if (noVote.length) log(`round ${roundLabel}: refuter cast no vote on ${noVote.length} finding(s) — excluded`)
    const surviving = verified
      .filter(Boolean)
      .filter(f => f.refute && f.refute.verdict !== 'refuted' && f.refute.confidence >= cfg.confidenceMin)

    const roundFile = `${cfg.dir}/reviews/${opts.roundFilePrefix}-${roundLabel}.md`
    const consolidation = await agent<ConsolidateResult>(
      `You are consolidating verified plan-review findings for round ${roundLabel} of strapped run "${cfg.slug}". Round-record format: ${cfg.conventionsFile}.${confirmation ? '\nThis is a CONFIRMATION pass after the final budgeted round: its findings were all fixed, and this pass re-checks whether any NEW gap remains.' : ''}

Surviving verified findings:
${JSON.stringify(surviving, null, 2)}

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

Seen digest from prior rounds:
${digest(seen)}

Prior round files live at ${cfg.dir}/reviews/${opts.roundFilePrefix}-*.md — read them.

Tasks:
1. Merge same-root-cause findings by key against this round's set and all prior rounds; a match on a prior key is a duplicate unless the prior record marks it fixed and the revision regressed.
2. Write ${roundFile} with frontmatter (round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a.map(r => r.id))}, reviewer_b_rules: ${JSON.stringify(rules.b.map(r => r.id))}, new_confirmed: <count>, outcome: converged if zero new confirmed else revise, findings list) and full finding bodies plus both rule checklists.
3. Return the ids of truly-NEW confirmed findings and the duplicate ids.`,
      { label: `consolidate:r${roundLabel}`, phase: phaseLabel, effort: 'low', schema: CONSOLIDATE_SCHEMA }
    )

    const newIds = new Set(consolidation ? consolidation.new_confirmed_ids : surviving.map(f => f.id))
    const newConfirmed = surviving.filter(f => newIds.has(f.id))
    log(`round ${roundLabel}: ${newConfirmed.length} NEW confirmed finding(s)`)
    return { newConfirmed, newIds, roundFile }
  }

  let lastRoundFixedAll = false
  let revisionFailed = false
  for (let round = 1; round <= maxRounds; round++) {
    roundsUsed = round
    lastRoundFixedAll = false

    const { newConfirmed, newIds, roundFile } = await runReviewRound(round, false)
    for (const f of newConfirmed) seen.push({ ...f, round, status: 'open' })

    if (newConfirmed.length === 0) {
      converged = true
      outstanding = []
      break
    }
    outstanding = newConfirmed

    phase(`Revise ${round}`)
    const revision = await agent<unknown>(opts.reviserPromptFn(newConfirmed, roundFile), { label: `revise:r${round}`, phase: `Revise ${round}` })
    if (revision) {
      for (const f of seen) if (newIds.has(f.id)) f.status = 'fixed'
      lastRoundFixedAll = true
    } else {
      revisionFailed = true
      break
    }
  }

  if (!converged && !revisionFailed && lastRoundFixedAll) {
    const { newConfirmed } = await runReviewRound(maxRounds, true)
    for (const f of newConfirmed) seen.push({ ...f, round: maxRounds, status: 'open' })
    if (newConfirmed.length === 0) {
      converged = true
      outstanding = []
    }
  }

  if (!converged) {
    outstanding = seen.filter(f => f.status === 'open')
  }

  return {
    converged,
    rounds: roundsUsed,
    outstanding: outstanding.map(f => ({ id: f.id, key: f.key, severity: f.severity, what: f.what })),
  }
}
