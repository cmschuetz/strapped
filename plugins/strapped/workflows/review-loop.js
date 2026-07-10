export const meta = {
  name: 'strapped-review-loop',
  description: 'Bounded adversarial review loop (2 rule-partitioned reviewers, refute pass, dedup-vs-seen, consolidate, reviser) over an ask + an artifact under review, with a final-round confirmation pass. Invoked via workflow({scriptPath}) by both plan-loop.js (plan flow) and feedback-synth.js (feedback flow).',
  phases: [
    { title: 'Review', detail: 'adversarial reviewers with disjoint rule halves' },
    { title: 'Verify', detail: 'refute pass per finding' },
    { title: 'Revise', detail: 'close confirmed gaps in the reviewed files' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

const roundFilePrefix = cfg.roundFilePrefix || 'plan-round'
const artifactDescription =
  cfg.artifactDescription || 'a produced implementation plan (manifest.md, research.md, and every file in deliverables/)'

const repos =
  Array.isArray(cfg.repos) && cfg.repos.length
    ? cfg.repos
    : cfg.repoRoot
    ? [{ name: cfg.repoRoot.split('/').filter(Boolean).pop() || cfg.repoRoot, root: cfg.repoRoot }]
    : []

function repoList() {
  if (!repos.length) return `Repo root: ${cfg.repoRoot}`
  return repos
    .map(r => `- ${r.name} → ${r.root}`)
    .join('\n')
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'rule_checklist'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'key', 'rule', 'severity', 'location', 'what', 'why', 'evidence', 'confidence', 'recommendation'],
        properties: {
          id: { type: 'string' },
          key: { type: 'string' },
          rule: { type: ['string', 'null'] },
          severity: { type: 'string', enum: ['blocking', 'concern', 'suggestion'] },
          location: { type: 'string' },
          what: { type: 'string' },
          why: { type: 'string' },
          evidence: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
          recommendation: { type: 'string' },
        },
      },
    },
    rule_checklist: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule', 'verdict', 'evidence'],
        properties: {
          rule: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'violation', 'na'] },
          evidence: { type: 'string' },
        },
      },
    },
  },
}

const REFUTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'evidence'],
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    confidence: { type: 'number', minimum: 0, maximum: 100 },
    evidence: { type: 'string' },
  },
}

const CONSOLIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['new_confirmed_ids', 'duplicate_ids'],
  properties: {
    new_confirmed_ids: { type: 'array', items: { type: 'string' } },
    duplicate_ids: { type: 'array', items: { type: 'string' } },
  },
}

const LENSES = {
  a: 'completeness: is every element of the original ask covered by some deliverable? Hunt for missing requirements, unhandled edge cases, acceptance criteria without tests, and parts of the ask that silently disappeared',
  b: 'soundness: wrong assumptions about the codebase, DAG dependency errors (missing or backwards deps, undeclared cross-deliverable coupling), deliverables that mix unrelated themes or whose estimated meaningful diff (excluding generated code, dependency bumps, and fixtures) exceeds ~1,000 lines and should be split, deliverables/chains that should be CONSOLIDATED (fragments of one theme, or a linear chain whose combined meaningful diff — excluding generated code, dependency bumps, and fixtures — is under the ~1,000-line threshold and could be a single deliverable/PR), and steps that cannot work as written',
}

function ruleBlock(rules) {
  return rules.map(r => `- ${r.id} (${r.source}): ${r.text}`).join('\n')
}

function digest(seen) {
  if (!seen.length) return '(none — first round)'
  return seen.map(f => `- [${f.severity}] ${f.key}: ${f.what} (round ${f.round}, ${f.status})`).join('\n')
}

function reviewerPrompt(which, rules, seen, round) {
  return `You are an adversarial plan reviewer with fresh context. Your job is to find real gaps between ${artifactDescription} and the original ask, before any code is written.

Original ask: ${cfg.ask}
Artifact under review, in ${cfg.dir}: ${artifactDescription}.
Conventions the plan must follow: ${cfg.conventionsFile}
Target repos (explore any of these as needed to check the plan's claims against reality):
${repoList()}

Read the original ask first, then the whole artifact under review, then verify claims against the actual codebase(s) where they matter.

Your lens (your main hunting ground beyond the rules): ${LENSES[which]}.
${which === 'b' ? `\nSoundness — multi-repo checks specific to this run: verify each deliverable has a \`repo:\` field naming one of the target repos above; verify each deliverable's \`base:\` obeys the cross-repo base rule (it is a branch in the SAME repo as the deliverable, or that repo's \`main\` for roots and for cross-repo children — a deliverable can never base on a branch in a different repo); and verify that no cross-repo dep is a true code dependency (cross-repo deps are ordering-only — flag any cross-repo child that would need its parent's unmerged code, since it bases on its own repo's \`main\` and does not have that code).\n` : ''}

Your assigned guideline rules — you are the ONLY reviewer checking the plan against these, so check every one explicitly (does the plan instruct or imply work that would violate the rule?):
${ruleBlock(rules)}

Known findings from earlier rounds — do NOT re-report unless the revision failed to address them:
${digest(seen)}

Severity: "blocking" = the plan as written produces wrong or missing work; "concern" = likely gap needing a fix or an explicit justification; "suggestion" = optional polish (never drives revision). Stable key format "<rule-id-or-gap>:<plan-location>". Confidence under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist verdict (pass/violation/na + one line of evidence) for every assigned rule (${rules.map(r => r.id).join(', ')}), plus your findings. Round: ${round}.`
}

function refutePrompt(f) {
  return `You are a skeptical verifier with fresh context. A plan reviewer claims the following gap in ${artifactDescription} at ${cfg.dir} (original ask: ${cfg.ask}). Target repos you may explore to check the claim:
${repoList()}

Claim [${f.severity}] at ${f.location}: ${f.what}
Why: ${f.why}
Evidence: ${f.evidence}

Your stance: this is NOT a real gap unless the documents prove otherwise. Read the ask and the artifact files yourself — the claimed-missing item may be covered elsewhere, the assumption may actually hold in the codebase, or the claim may misread the ask. Return your verdict, a corrected confidence (0-100) that the gap is real, and one line of evidence.`
}

const defaultReviserPrompt = (newConfirmed, roundFile) =>
  `You are the plan reviser for strapped run "${cfg.slug}". Close every confirmed review finding by editing the plan files in ${cfg.dir} (manifest.md, research.md, deliverables/*.md), keeping every file conformant to ${cfg.conventionsFile}. Original ask for reference: ${cfg.ask}. Target repos (fix repo assignments and cross-repo base rules against these):
${repoList()}

Confirmed findings to close (full bodies also in ${roundFile}):
${JSON.stringify(newConfirmed.map(f => ({ id: f.id, key: f.key, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

For each finding: apply the fix (this may mean splitting a deliverable that mixes unrelated themes or exceeds the ~1,000-line meaningful-diff threshold, adding a missing deliverable, fixing deps in BOTH the manifest and the deliverable frontmatter, adding acceptance criteria or tests, or correcting a wrong assumption after re-checking the code). Then update ${roundFile}: flip each addressed finding's status from open to fixed. Return one line per finding: id — what you changed.`

function reviserPrompt(newConfirmed, roundFile) {
  if (cfg.reviserPrompt) {
    return cfg.reviserPrompt
      .replace('{{findings}}', JSON.stringify(newConfirmed.map(f => ({ id: f.id, key: f.key, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2))
      .replace('{{roundFile}}', roundFile)
  }
  return defaultReviserPrompt(newConfirmed, roundFile)
}

const seen = []
let converged = false
let roundsUsed = 0
let outstanding = []

async function runReviewRound(round, confirmation) {
  const rules = cfg.rulesByRound[round - 1]
  const seedUsed = cfg.seed + round
  const roundLabel = confirmation ? `${round}-confirm` : `${round}`
  const phaseLabel = confirmation ? `Confirm ${round}` : `Review ${round}`

  phase(phaseLabel)
  const reviews = await parallel([
    () => agent(reviewerPrompt('a', rules.a, seen, round), { label: `plan-review:a:r${roundLabel}`, schema: FINDINGS_SCHEMA }),
    () => agent(reviewerPrompt('b', rules.b, seen, round), { label: `plan-review:b:r${roundLabel}`, schema: FINDINGS_SCHEMA }),
  ])

  const tagged = reviews.map((r, i) => ({ r, which: i === 0 ? 'a' : 'b' })).filter(x => x.r)
  const allFindings = tagged.flatMap(x => x.r.findings.map(f => ({ ...f, id: `r${roundLabel}-${x.which}-${f.id}` })))
  const checklists = Object.fromEntries(tagged.map(x => [x.which, x.r.rule_checklist]))
  const gating = allFindings.filter(f => f.severity !== 'suggestion')
  const suggestions = allFindings.filter(f => f.severity === 'suggestion')
  log(`round ${roundLabel}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

  const verified = await parallel(
    gating.map(f => () =>
      agent(refutePrompt(f), { label: `refute:${f.id}`, phase: 'Verify', effort: 'low', schema: REFUTE_SCHEMA })
        .then(v => ({ ...f, refute: v }))
    )
  )
  const surviving = verified
    .filter(Boolean)
    .filter(f => f.refute.verdict !== 'refuted' && f.refute.confidence >= cfg.confidenceMin)

  const roundFile = `${cfg.dir}/reviews/${roundFilePrefix}-${roundLabel}.md`
  const consolidation = await agent(
    `You are consolidating verified plan-review findings for round ${roundLabel} of strapped run "${cfg.slug}". Round-record format: ${cfg.conventionsFile}.${confirmation ? '\nThis is a CONFIRMATION pass after the final budgeted round: its findings were all fixed, and this pass re-checks whether any NEW gap remains.' : ''}

Surviving verified findings:
${JSON.stringify(surviving, null, 2)}

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

Seen digest from prior rounds:
${digest(seen)}

Prior round files live at ${cfg.dir}/reviews/${roundFilePrefix}-*.md — read them.

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
for (let round = 1; round <= cfg.maxRounds; round++) {
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
  const revision = await agent(reviserPrompt(newConfirmed, roundFile), { label: `revise:r${round}`, phase: `Revise ${round}` })
  if (revision) {
    for (const f of seen) if (newIds.has(f.id)) f.status = 'fixed'
    lastRoundFixedAll = true
  } else {
    revisionFailed = true
    break
  }
}

if (!converged && !revisionFailed && lastRoundFixedAll) {
  const { newConfirmed } = await runReviewRound(cfg.maxRounds, true)
  for (const f of newConfirmed) seen.push({ ...f, round: cfg.maxRounds, status: 'open' })
  if (newConfirmed.length === 0) {
    converged = true
    outstanding = []
  }
}

if (!converged) {
  outstanding = seen.filter(f => f.status === 'open')
}

return {
  slug: cfg.slug,
  converged,
  rounds: roundsUsed,
  outstanding: outstanding.map(f => ({ id: f.id, key: f.key, severity: f.severity, what: f.what })),
}
