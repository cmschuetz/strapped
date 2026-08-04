// The shared bounded adversarial review loop (plan flow + feedback flow):
// 2 rule-partitioned reviewers, then ONE verify-consolidate agent per round
// (batch skeptical verification of every gating finding + dedup-vs-seen
// consolidation writing reviews/<prefix>-round-<N>.md), reviser, final-round
// confirmation. A 0-round budget skips the loop entirely (converged, rounds 0).

import { repoList, rulesFileFor, rulesForRound } from './config.ts'
import { FINDINGS_SCHEMA, VERIFY_SCHEMA } from './schemas.generated.ts'
import type {
  Finding,
  FindingsResult,
  RepoRef,
  ReviewLoopResult,
  ReviewerId,
  RunConfig,
  SeenFinding,
  VerifyResult,
} from './types.ts'

export const PLAN_LENSES: Record<ReviewerId, string> = {
  a: 'completeness: is every element of the original ask covered by some deliverable? Hunt for missing requirements, unhandled edge cases, acceptance criteria without tests, and parts of the ask that silently disappeared',
  b: 'soundness: wrong assumptions about the codebase, DAG dependency errors (missing or backwards deps, undeclared cross-deliverable coupling), deliverables that mix unrelated themes or whose estimated meaningful diff (excluding generated code, dependency bumps, and fixtures) exceeds ~1,000 lines and should be split, deliverables/chains that should be CONSOLIDATED (fragments of one theme, or a linear chain whose combined meaningful diff — excluding generated code, dependency bumps, and fixtures — is under the ~1,000-line threshold and could be a single deliverable/PR), planned work that is dead, duplicated, or superseded within the plan (steps or files a later step obviates, two deliverables doing the same work, or acceptance criteria/tests no remaining step produces), and steps that cannot work as written',
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
  verifyArtifactPhrase: string
  reviserPromptFn: (newConfirmed: Finding[], roundFile: string) => string
  roundFilePrefix: string
  maxRounds: number
  /**
   * Human label for the artifact's own enumerated items — 'AC' for the plan
   * flow's acceptance criteria, 'FA' for the feedback flow's addendum tasks.
   * The reviewers enumerate items as `<label>1..<label>n`.
   */
  enumeratedItemsLabel: string
  /**
   * The Markdown heading whose items the reviewers enumerate into the
   * `ac_checklist` — `## Acceptance criteria` for plans, `## Feedback addendum`
   * for the feedback flow.
   */
  enumeratedItemsSection: string
}

// Runs the bounded adversarial review loop (2 rule-partitioned reviewers, one
// batch verify-consolidate agent writing reviews/<prefix>-round-<N>.md,
// reviser, final-round confirmation pass) over an ask + an artifact. A
// maxRounds of 0 means "skip adversarial review entirely and trust the
// producer": no review agents run and the loop returns converged.
export async function runReviewLoop(cfg: RunConfig, opts: ReviewLoopOpts): Promise<ReviewLoopResult> {
  const maxRounds = opts.maxRounds
  if (maxRounds === 0) {
    log('review budget 0 — skipping adversarial review')
    return { converged: true, rounds: 0, outstanding: [] }
  }
  const artifactNounCap = opts.artifactNoun.charAt(0).toUpperCase() + opts.artifactNoun.slice(1)
  const rulesFile = rulesFileFor(cfg)

  function reviewerPrompt(which: ReviewerId, rules: readonly string[], seen: readonly SeenFinding[], round: number): string {
    return `You are an adversarial plan reviewer with fresh context. Your job is to find real gaps between ${opts.artifactDescription} and the original ask, before any code is written.

Original ask: ${opts.ask}
${artifactNounCap} under review, in ${cfg.dir}: ${opts.artifactLocation}.
Conventions the plan must follow: ${cfg.conventionsFile}
Target repos (explore any of these as needed to check the plan's claims against reality):
${repoList(opts.repos)}

Read the original ask first, then the whole ${opts.artifactNoun}, then verify claims against the actual codebase(s) where they matter.

Your lens (your main hunting ground beyond the rules): ${PLAN_LENSES[which]}.
${which === 'b' ? `\nSoundness — multi-repo checks specific to this run: verify each deliverable has a \`repo:\` field naming one of the target repos above; verify each deliverable's \`base:\` obeys the cross-repo base rule (it is a branch in the SAME repo as the deliverable, or that repo's \`main\` for roots and for cross-repo children — a deliverable can never base on a branch in a different repo); and verify that any child depending on work that must first land through some external step outside this run's control (e.g. a cross-repo parent's output becoming available in the child's repo) DECLARES that prerequisite under a \`## Preconditions\` section in its body — such dependencies are legitimate DAG nodes that park at implement time when the precondition is unmet, so flag a MISSING declaration, never the dependency itself.\n` : ''}
Your assigned guideline rules — you are the ONLY reviewer checking the plan against these, so check every one explicitly (does the plan instruct or imply work that would violate the rule?): ${rules.join(', ')}.
These ids are your whole assignment, but they carry no text here: before reviewing, Read the rules snapshot at ${rulesFile} for each assigned rule's verbatim text (one \`- <id> (<source>): <text>\` line per rule; ignore the ids not assigned to you).

Known findings from earlier rounds — do NOT re-report unless the revision failed to address them:
${digest(seen)}

Enumerated ${opts.enumeratedItemsLabel} checklist — you and the other reviewer BOTH return this every round (it is NOT partitioned like the guideline rules): read EVERY artifact file's \`${opts.enumeratedItemsSection}\` section, enumerate each item in order as ${opts.enumeratedItemsLabel}1..${opts.enumeratedItemsLabel}n across the whole artifact, and return one ac_checklist entry per item ({ id: "${opts.enumeratedItemsLabel}<k>", verdict: pass|violation|na, evidence: one line }). An item the ${opts.artifactNoun} fails to satisfy, or that no step/test covers, is a BLOCKING finding carrying full guideline-rule weight — enumerating and checking these items is as load-bearing as the rule checklist. If no file has a \`${opts.enumeratedItemsSection}\` section, return \`ac_checklist: []\`.

Severity: "blocking" = the plan as written produces wrong or missing work; "concern" = likely gap needing a fix or an explicit justification; "suggestion" = optional polish (never drives revision). Stable key format "<rule-id-or-gap>:<plan-location>". Confidence under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist verdict (pass/violation/na + one line of evidence) for every assigned rule (${rules.join(', ')}), the ac_checklist covering every ${opts.enumeratedItemsLabel} item, plus your findings. Round: ${round}.`
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
    const acChecklists = Object.fromEntries(tagged.map(x => [x.which, x.r.ac_checklist] as const))
    const gating = allFindings.filter(f => f.severity !== 'suggestion')
    const suggestions = allFindings.filter(f => f.severity === 'suggestion')
    log(`round ${roundLabel}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

    const roundFile = `${cfg.dir}/reviews/${opts.roundFilePrefix}-${roundLabel}.md`
    // Zero gating findings → nothing to adjudicate or dedup: a record-writer
    // fast path replaces the skeptical-verifier procedure (clean rounds are the
    // common case and were paying ~3x the consolidation turns).
    const verification = await agent<VerifyResult>(
      gating.length === 0
        ? `You are the record-writer for round ${roundLabel} of strapped run "${cfg.slug}". This round is CLEAN: the reviewers returned zero gating findings, so there is nothing to adjudicate and nothing to dedup. Do NOT re-review ${opts.verifyArtifactPhrase} and do NOT read the ${opts.artifactNoun} files — your only job is the round record. Round-record format: ${cfg.conventionsFile}.

Write ${roundFile} with frontmatter (round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a)}, reviewer_b_rules: ${JSON.stringify(rules.b)}, new_confirmed: 0, outcome: converged, findings list = the suggestions below with status suggestion) and a body carrying the suggestions plus both rule checklists AND both AC/addendum checklists verbatim.

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

AC/addendum checklists: ${JSON.stringify(acChecklists, null, 2)}

Return empty verdicts, empty new-confirmed ids, and empty duplicate ids.`
        : `You are the verify-consolidate agent for round ${roundLabel} of strapped run "${cfg.slug}": a skeptical verifier adjudicating EVERY gating finding in one batch pass, then the round's consolidator writing its record. Round-record format: ${cfg.conventionsFile}.${confirmation ? '\nThis is a CONFIRMATION pass after the final budgeted round: its findings were all fixed, and this pass re-checks whether any NEW gap remains.' : ''}

Plan reviewers claim the following gaps in ${opts.verifyArtifactPhrase} at ${cfg.dir} (original ask: ${opts.ask}). Target repos you may explore to check each claim:
${repoList(opts.repos)}

The guideline rules behind rule-keyed findings and the checklists carry only their ids here — the verbatim rule text lives in the rules snapshot at ${rulesFile}; Read it whenever a rule's wording matters to a verdict.

Gating findings to adjudicate:
${JSON.stringify(gating, null, 2)}

Verification stance, applied to each finding independently: it is NOT a real gap unless the documents prove otherwise. Read the ask and the ${opts.artifactNoun} files yourself — a claimed-missing item may be covered elsewhere in the ${opts.artifactNoun}, the assumption may actually hold in the codebase, or the claim may misread the ask. Cast one verdict per finding id — "confirmed" (the gap is proven real), "plausible" (credible but unproven), or "refuted" (not a real gap) — with a corrected confidence (0-100) that the gap is real and one line of evidence. A finding with verdict refuted, or confidence below ${cfg.confidenceMin}, does not survive.

Suggestions (non-gating, never verified, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

AC/addendum checklists (per-item ${opts.enumeratedItemsLabel} pass/violation/na verdicts from each reviewer): ${JSON.stringify(acChecklists, null, 2)}

Seen digest from prior rounds:
${digest(seen)}

Prior round files live at ${cfg.dir}/reviews/${opts.roundFilePrefix}-*.md — read them.

Consolidation tasks, over the findings that survive your verdicts:
1. Merge same-root-cause findings by key against this round's set and all prior rounds; a match on a prior key is a duplicate unless the prior record marks it fixed and the revision regressed.
2. Write ${roundFile} with frontmatter (round: ${roundLabel}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a)}, reviewer_b_rules: ${JSON.stringify(rules.b)}, new_confirmed: <count>, outcome: converged if zero new confirmed else revise, findings list with one entry per finding carrying { id, key, severity, verdict: confirmed|plausible|refuted, confidence, status: open|refuted|duplicate } per the conventions) and full finding bodies plus both rule checklists AND both AC/addendum checklists (the per-item ${opts.enumeratedItemsLabel} pass/violation/na verdicts).
3. Return your per-finding verdicts, the ids of truly-NEW confirmed findings (surviving and not duplicates), and the duplicate ids.`,
      { label: `verify:r${roundLabel}`, phase: phaseLabel, effort: 'low', schema: VERIFY_SCHEMA }
    )

    // A null verifier result is a vote NOT cast on every finding — never
    // dereferenced, and a finding without a cast confirming vote never survives.
    if (!verification) {
      if (gating.length) log(`round ${roundLabel}: verifier cast no vote — ${gating.length} gating finding(s) excluded`)
      return { newConfirmed: [] as Finding[], newIds: new Set<string>(), roundFile }
    }
    const verdictById = new Map(verification.verdicts.map(v => [v.id, v] as const))
    const noVote = gating.filter(f => !verdictById.has(f.id))
    if (noVote.length) log(`round ${roundLabel}: verifier cast no vote on ${noVote.length} finding(s) — excluded`)
    const surviving = gating.filter(f => {
      const v = verdictById.get(f.id)
      return v !== undefined && v.verdict !== 'refuted' && v.confidence >= cfg.confidenceMin
    })
    const newIds = new Set(verification.new_confirmed_ids)
    const newConfirmed = surviving.filter(f => newIds.has(f.id))
    log(`round ${roundLabel}: ${newConfirmed.length} NEW confirmed finding(s)`)
    return { newConfirmed, newIds: new Set(newConfirmed.map(f => f.id)), roundFile }
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
