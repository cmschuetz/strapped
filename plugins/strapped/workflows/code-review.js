export const meta = {
  name: 'strapped-code-review',
  description: 'One adversarial code-review round for one deliverable: 2 rule-partitioned reviewers, per-finding refute pass, dedup-vs-seen consolidation',
  phases: [
    { title: 'Review', detail: '2 reviewers with disjoint rule halves and distinct lenses' },
    { title: 'Verify', detail: 'fresh refuter per blocking/concern finding' },
    { title: 'Consolidate', detail: 'dedup vs seen, write round record' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

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
          key: { type: 'string', description: '<rule-id-or-gap>:<location>, stable across rounds for dedup' },
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
  a: 'correctness: logic bugs, unhandled edge cases, race conditions, broken error paths, and acceptance-criteria compliance',
  b: 'convention and test fidelity: adherence to the assigned guidelines, and test quality — integration-style tests of public interfaces, no mocking, aiohttp test servers for network, polyfactory for stubs',
}

function ruleBlock(rules) {
  return rules.map(r => `- ${r.id} (${r.source}): ${r.text}`).join('\n')
}

function reviewerPrompt(which) {
  const rules = cfg.rules[which]
  return `You are an adversarial code reviewer with fresh context. Review exactly one deliverable's implementation.

Deliverable: ${cfg.deliverableId} of strapped run "${cfg.slug}".
Worktree (the code under review lives here): ${cfg.worktree}${cfg.repo ? `\nTarget repo: ${cfg.repo}${cfg.repoRoot ? ` (root ${cfg.repoRoot})` : ''}` : ''}
Branch: ${cfg.branch}   Base: ${cfg.base}

Procedure:
1. Read the deliverable plan at ${cfg.planFile} — its acceptance criteria define what the code must do.
2. In the worktree, run: git diff ${cfg.base}...${cfg.branch}
3. Read every touched file in full in the worktree, plus any callers or tests you need for context.
${cfg.validations && cfg.validations.length ? `\nThis repo's validations (must be green for the deliverable — assume the implementer ran them; flag any code that would break one):\n${cfg.validations.map(v => `- ${v}`).join('\n')}\n` : ''}

Your lens (your primary hunting ground beyond the rules): ${LENSES[which]}.

Your assigned guideline rules — you are the ONLY reviewer checking these, so check every one explicitly:
${ruleBlock(rules)}

Known findings from earlier rounds — do NOT re-report these unless the code has regressed:
${cfg.seenDigest || '(none — first round)'}

Report only real, evidenced issues. Severity: "blocking" = bug or guideline violation that must be fixed; "concern" = likely problem needing a fix or justification; "suggestion" = optional polish (never drives rework). For each finding give a stable key "<rule-id-or-gap>:<file-or-location>". Set confidence honestly — findings under ${cfg.confidenceMin} will be dropped.

You MUST return a rule_checklist entry with a pass/violation/na verdict and one line of evidence for every assigned rule (${rules.map(r => r.id).join(', ')}), plus your findings.`
}

function refutePrompt(f) {
  return `You are a skeptical verifier with fresh context. A code reviewer claims the following issue in deliverable ${cfg.deliverableId} (worktree: ${cfg.worktree}, diff: git diff ${cfg.base}...${cfg.branch}).

Claim [${f.severity}] at ${f.location}: ${f.what}
Why the reviewer thinks so: ${f.why}
Their evidence: ${f.evidence}

Your stance: this is NOT a real issue unless the code proves otherwise. Read the actual code in the worktree and try to refute the claim — look for handling the reviewer missed, misread control flow, or a claim about code that does not exist. Return your verdict, a corrected confidence (0-100) that the issue is real, and one line of evidence.`
}

phase('Review')
const reviews = await parallel([
  () => agent(reviewerPrompt('a'), { label: `review:${cfg.deliverableId}:a`, schema: FINDINGS_SCHEMA }),
  () => agent(reviewerPrompt('b'), { label: `review:${cfg.deliverableId}:b`, schema: FINDINGS_SCHEMA }),
])

const tagged = reviews
  .map((r, i) => ({ r, which: i === 0 ? 'a' : 'b' }))
  .filter(x => x.r)
const allFindings = tagged.flatMap(x =>
  x.r.findings.map(f => ({ ...f, id: `${x.which}-${f.id}`, reviewer: x.which }))
)
const checklists = Object.fromEntries(tagged.map(x => [x.which, x.r.rule_checklist]))

const gating = allFindings.filter(f => f.severity !== 'suggestion')
const suggestions = allFindings.filter(f => f.severity === 'suggestion')
log(`round ${cfg.round}: ${gating.length} gating finding(s), ${suggestions.length} suggestion(s)`)

phase('Verify')
const verified = await parallel(
  gating.map(f => () =>
    agent(refutePrompt(f), { label: `refute:${f.id}`, effort: 'low', schema: REFUTE_SCHEMA })
      .then(v => ({ ...f, refute: v }))
  )
)

const surviving = verified
  .filter(Boolean)
  .filter(f => f.refute.verdict !== 'refuted' && f.refute.confidence >= cfg.confidenceMin)
const dropped = gating.length - surviving.length
if (dropped > 0) log(`refute pass dropped ${dropped} finding(s)`)

phase('Consolidate')
const roundFile = `${cfg.dir}/reviews/${cfg.deliverableId}-code-round-${cfg.round}.md`
const consolidation = await agent(
  `You are consolidating verified code-review findings for deliverable ${cfg.deliverableId}, round ${cfg.round}, of strapped run "${cfg.slug}". Follow the round-record format in ${cfg.conventionsFile}.

Surviving verified findings (already passed the refute filter):
${JSON.stringify(surviving, null, 2)}

Suggestions (non-gating, record only):
${JSON.stringify(suggestions, null, 2)}

Rule checklists: ${JSON.stringify(checklists, null, 2)}

Seen digest from prior rounds:
${cfg.seenDigest || '(none — first round)'}

Prior round record files, if any, live in ${cfg.dir}/reviews/ named ${cfg.deliverableId}-code-round-*.md — read them.

Tasks:
1. Merge same-root-cause findings by key against BOTH this round's set and all prior rounds. A finding matching a prior round's key is a duplicate unless the prior record marks it fixed and it has regressed.
2. Write the round record to ${roundFile} with frontmatter: round: ${cfg.round}, seed_used: ${cfg.seedUsed}, reviewer_a_rules: ${JSON.stringify(cfg.rules.a.map(r => r.id))}, reviewer_b_rules: ${JSON.stringify(cfg.rules.b.map(r => r.id))}, new_confirmed: <count>, outcome: ${'revise-or-converged (pick: converged if zero new confirmed, else revise)'}, and the findings list (status: open for new confirmed, duplicate for duplicates). Body: full finding bodies (what/why/evidence/recommendation) plus the two rule checklists.
3. Return the ids of truly-NEW confirmed findings and the ids of duplicates.`,
  { label: `consolidate:${cfg.deliverableId}:r${cfg.round}`, effort: 'low', schema: CONSOLIDATE_SCHEMA }
)

const newIds = new Set(consolidation ? consolidation.new_confirmed_ids : surviving.map(f => f.id))
const newConfirmed = surviving.filter(f => newIds.has(f.id))
log(`round ${cfg.round}: ${newConfirmed.length} NEW confirmed finding(s)`)

return {
  deliverableId: cfg.deliverableId,
  round: cfg.round,
  newConfirmed,
  suggestions,
  roundFile,
  converged: newConfirmed.length === 0,
}
