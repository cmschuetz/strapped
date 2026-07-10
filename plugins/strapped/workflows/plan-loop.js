export const meta = {
  name: 'strapped-plan-loop',
  description: 'Planner produces a DAG plan from a source plan.md, then a bounded adversarial review loop (2 rule-partitioned reviewers, refute pass, dedup-vs-seen, reviser) runs until converged',
  phases: [
    { title: 'Plan', detail: 'research the codebase, write research.md + manifest + deliverables' },
    { title: 'Review', detail: 'adversarial reviewers with disjoint rule halves' },
    { title: 'Verify', detail: 'refute pass per finding' },
    { title: 'Revise', detail: 'close confirmed gaps in the plan files' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['deliverables', 'summary'],
  properties: {
    deliverables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'file', 'title', 'deps'],
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          title: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
  },
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
  b: 'soundness: wrong assumptions about the codebase, DAG dependency errors (missing or backwards deps, undeclared cross-deliverable coupling), deliverables that exceed the ~500-line complex-diff target and should be split, and steps that cannot work as written',
}

function ruleBlock(rules) {
  return rules.map(r => `- ${r.id} (${r.source}): ${r.text}`).join('\n')
}

function digest(seen) {
  if (!seen.length) return '(none — first round)'
  return seen.map(f => `- [${f.severity}] ${f.key}: ${f.what} (round ${f.round}, ${f.status})`).join('\n')
}

function reviewerPrompt(which, rules, seen, round) {
  return `You are an adversarial plan reviewer with fresh context. Your job is to find real gaps between a produced implementation plan and the original ask, before any code is written.

Original ask: ${cfg.sourcePlan}
Plan under review, in ${cfg.dir}: manifest.md, research.md, and every file in deliverables/.
Conventions the plan must follow: ${cfg.conventionsFile}
Repo root (explore as needed to check the plan's claims against reality): ${cfg.repoRoot}

Read the original ask first, then the whole plan, then verify claims against the actual codebase where they matter.

Your lens (your primary hunting ground beyond the rules): ${LENSES[which]}.

Your assigned guideline rules — you are the ONLY reviewer checking the plan against these, so check every one explicitly (does the plan instruct or imply work that would violate the rule?):
${ruleBlock(rules)}

Known findings from earlier rounds — do NOT re-report unless the revision failed to address them:
${digest(seen)}

Severity: "blocking" = the plan as written produces wrong or missing work; "concern" = likely gap needing a fix or an explicit justification; "suggestion" = optional polish (never drives revision). Stable key format "<rule-id-or-gap>:<plan-location>". Confidence under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist verdict (pass/violation/na + one line of evidence) for every assigned rule (${rules.map(r => r.id).join(', ')}), plus your findings. Round: ${round}.`
}

function refutePrompt(f) {
  return `You are a skeptical verifier with fresh context. A plan reviewer claims the following gap in the implementation plan at ${cfg.dir} (original ask: ${cfg.sourcePlan}, repo: ${cfg.repoRoot}).

Claim [${f.severity}] at ${f.location}: ${f.what}
Why: ${f.why}
Evidence: ${f.evidence}

Your stance: this is NOT a real gap unless the documents prove otherwise. Read the ask and the plan files yourself — the claimed-missing item may be covered elsewhere in the plan, the assumption may actually hold in the codebase, or the claim may misread the ask. Return your verdict, a corrected confidence (0-100) that the gap is real, and one line of evidence.`
}

phase('Plan')
const plan = await agent(
  `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

Source plan (the original ask): ${cfg.sourcePlan}
Repo root: ${cfg.repoRoot}
Output directory (already scaffolded): ${cfg.dir}
Conventions you MUST follow for every file format: ${cfg.conventionsFile}

Procedure:
1. Read the source plan in full, then research the codebase thoroughly: architecture, the modules the ask touches, existing utilities to reuse, test patterns.
2. Write ${cfg.dir}/research.md — a distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see.
3. Split the work into deliverables of roughly 500 lines of complex diff each, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Prefer more, smaller, independently-shippable nodes over fewer large ones.
4. Write one self-contained file per deliverable at ${cfg.dir}/deliverables/<id>-<kebab>.md per the conventions (frontmatter: id, title, deps, status: pending, branch: strapped/${cfg.slug}/<id>-<kebab>, base: parent branch or main, worktree: null, pr: null, review_rounds_used: 0, parked_reason: null, estimated_diff_lines; body: Context slice from your research, Files to touch, Implementation steps, Acceptance criteria, Tests, Out of scope). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. Write ${cfg.dir}/manifest.md per the conventions (status: in-review, seed: ${cfg.seed}, the deliverables list with ids/files/deps, theme summary, ASCII DAG sketch).

Return the deliverable list and a one-paragraph summary.`,
  { label: 'planner', schema: PLAN_SCHEMA }
)
if (!plan) throw new Error('planner agent failed')
log(`plan produced: ${plan.deliverables.length} deliverable(s)`)

const seen = []
let converged = false
let roundsUsed = 0
let outstanding = []

for (let round = 1; round <= cfg.maxRounds; round++) {
  roundsUsed = round
  const rules = cfg.rulesByRound[round - 1]
  const seedUsed = cfg.seed + round

  phase(`Review ${round}`)
  const reviews = await parallel([
    () => agent(reviewerPrompt('a', rules.a, seen, round), { label: `plan-review:a:r${round}`, schema: FINDINGS_SCHEMA }),
    () => agent(reviewerPrompt('b', rules.b, seen, round), { label: `plan-review:b:r${round}`, schema: FINDINGS_SCHEMA }),
  ])

  const tagged = reviews.map((r, i) => ({ r, which: i === 0 ? 'a' : 'b' })).filter(x => x.r)
  const allFindings = tagged.flatMap(x => x.r.findings.map(f => ({ ...f, id: `r${round}-${x.which}-${f.id}` })))
  const checklists = Object.fromEntries(tagged.map(x => [x.which, x.r.rule_checklist]))
  const gating = allFindings.filter(f => f.severity !== 'suggestion')
  const suggestions = allFindings.filter(f => f.severity === 'suggestion')
  log(`round ${round}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

  const verified = await parallel(
    gating.map(f => () =>
      agent(refutePrompt(f), { label: `refute:${f.id}`, phase: 'Verify', effort: 'low', schema: REFUTE_SCHEMA })
        .then(v => ({ ...f, refute: v }))
    )
  )
  const surviving = verified
    .filter(Boolean)
    .filter(f => f.refute.verdict !== 'refuted' && f.refute.confidence >= cfg.confidenceMin)

  const roundFile = `${cfg.dir}/reviews/plan-round-${round}.md`
  const consolidation = await agent(
    `You are consolidating verified plan-review findings for round ${round} of strapped run "${cfg.slug}". Round-record format: ${cfg.conventionsFile}.

Surviving verified findings:
${JSON.stringify(surviving, null, 2)}

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

Seen digest from prior rounds:
${digest(seen)}

Prior round files live at ${cfg.dir}/reviews/plan-round-*.md — read them.

Tasks:
1. Merge same-root-cause findings by key against this round's set and all prior rounds; a match on a prior key is a duplicate unless the prior record marks it fixed and the revision regressed.
2. Write ${roundFile} with frontmatter (round: ${round}, seed_used: ${seedUsed}, reviewer_a_rules: ${JSON.stringify(rules.a.map(r => r.id))}, reviewer_b_rules: ${JSON.stringify(rules.b.map(r => r.id))}, new_confirmed: <count>, outcome: converged if zero new confirmed else revise, findings list) and full finding bodies plus both rule checklists.
3. Return the ids of truly-NEW confirmed findings and the duplicate ids.`,
    { label: `consolidate:r${round}`, phase: `Review ${round}`, effort: 'low', schema: CONSOLIDATE_SCHEMA }
  )

  const newIds = new Set(consolidation ? consolidation.new_confirmed_ids : surviving.map(f => f.id))
  const newConfirmed = surviving.filter(f => newIds.has(f.id))
  for (const f of newConfirmed) seen.push({ ...f, round, status: 'open' })
  log(`round ${round}: ${newConfirmed.length} NEW confirmed finding(s)`)

  if (newConfirmed.length === 0) {
    converged = true
    outstanding = []
    break
  }
  outstanding = newConfirmed

  phase(`Revise ${round}`)
  const revision = await agent(
    `You are the plan reviser for strapped run "${cfg.slug}". Close every confirmed review finding by editing the plan files in ${cfg.dir} (manifest.md, research.md, deliverables/*.md), keeping every file conformant to ${cfg.conventionsFile}. Original ask for reference: ${cfg.sourcePlan}. Repo root: ${cfg.repoRoot}.

Confirmed findings to close (full bodies also in ${roundFile}):
${JSON.stringify(newConfirmed.map(f => ({ id: f.id, key: f.key, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

For each finding: apply the fix (this may mean splitting an oversized deliverable, adding a missing deliverable, fixing deps in BOTH the manifest and the deliverable frontmatter, adding acceptance criteria or tests, or correcting a wrong assumption after re-checking the code). Then update ${roundFile}: flip each addressed finding's status from open to fixed. Return one line per finding: id — what you changed.`,
    { label: `revise:r${round}`, phase: `Revise ${round}` }
  )
  if (revision) for (const f of seen) if (newIds.has(f.id)) f.status = 'fixed'
}

return {
  slug: cfg.slug,
  converged,
  rounds: roundsUsed,
  deliverables: plan.deliverables,
  outstanding: outstanding.map(f => ({ id: f.id, key: f.key, severity: f.severity, what: f.what })),
  summary: plan.summary,
}
