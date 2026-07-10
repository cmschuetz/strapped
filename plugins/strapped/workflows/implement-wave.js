export const meta = {
  name: 'strapped-implement-wave',
  description: 'Implement one ready wave of DAG deliverables: fresh implementer per node in its persistent worktree, validations, then a bounded adversarial code-review/fix loop per node',
  phases: [
    { title: 'Implement', detail: 'fresh implementer per deliverable, seeded with only its plan file + research digest' },
    { title: 'Fix', detail: 'close confirmed findings, re-validate' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'validations_green', 'blocker'],
  properties: {
    status: { type: 'string', enum: ['implemented', 'blocked'] },
    summary: { type: 'string' },
    validations_green: { type: 'boolean' },
    blocker: { type: ['string', 'null'] },
  },
}

function digest(seen) {
  if (!seen.length) return ''
  return seen.map(f => `- [${f.severity}] ${f.key}: ${f.what} (round ${f.round}, ${f.status})`).join('\n')
}

function implementPrompt(item) {
  return `You are the implementation agent for deliverable ${item.id} of strapped run "${cfg.slug}". You have fresh context — everything you need is in the files below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read your deliverable plan in full: ${item.planFile}
2. Read the shared research digest: ${cfg.dir}/research.md
3. Read the project guidelines: every CLAUDE.md that applies (repo root at minimum).
${item.resumeNote ? `\nThis deliverable is being RESUMED. Prior state:\n${item.resumeNote}\n` : ''}
Implement exactly what the plan specifies — its acceptance criteria are the contract. Write the tests the plan names (integration-style, public interfaces). Stay in scope: anything under "Out of scope" is off limits; note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit your work on ${item.branch} with a conventional-commit message referencing ${item.id}. If validations pass, commit and return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (missing dependency, contradictory plan, validation failure you cannot fix), commit what is safe, return status "blocked" with the blocker described — do NOT loop indefinitely.`
}

function fixPrompt(item, findings, round) {
  return `You are the fix agent for deliverable ${item.id} of strapped run "${cfg.slug}", code-review round ${round}. Fresh context — everything you need is below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read the deliverable plan: ${item.planFile}
2. Read the research digest: ${cfg.dir}/research.md
3. Read the full round record: ${cfg.dir}/reviews/${item.id}-code-round-${round}.md

Confirmed findings you must fix:
${JSON.stringify(findings.map(f => ({ id: f.id, key: f.key, severity: f.severity, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

Fix every finding. Then re-run ALL validations inside the worktree until green:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit the fixes on ${item.branch}. Update the round record: flip each fixed finding's status from open to fixed. Return status "implemented" with validations_green true, or "blocked" with the blocker if a finding cannot be fixed as recommended (do not silently skip it).`
}

async function implementStage(item) {
  const result = await agent(implementPrompt(item), {
    label: `implement:${item.id}`,
    phase: 'Implement',
    schema: IMPLEMENT_SCHEMA,
  })
  if (!result) return { item, outcome: 'parked', parkedReason: 'implementer agent failed', roundsUsed: 0 }
  if (result.status === 'blocked' || !result.validations_green) {
    return { item, outcome: 'parked', parkedReason: result.blocker || 'validations not green after implementation', roundsUsed: 0, summary: result.summary }
  }
  return { item, outcome: 'implemented', summary: result.summary, roundsUsed: 0 }
}

async function reviewFixLoop(state) {
  if (state.outcome === 'parked') return { ...state, suggestions: [] }
  const item = state.item
  const seen = []
  const suggestions = []
  let converged = false
  let roundsUsed = 0
  let parkedReason = null

  for (let round = 1; round <= cfg.codeRounds; round++) {
    roundsUsed = round
    const review = await workflow(cfg.codeReviewScript ? { scriptPath: cfg.codeReviewScript } : 'strapped-code-review', {
      slug: cfg.slug,
      deliverableId: item.id,
      dir: cfg.dir,
      conventionsFile: cfg.conventionsFile,
      worktree: item.worktree,
      repo: item.repo,
      repoRoot: item.repoRoot,
      validations: item.validations,
      branch: item.branch,
      base: item.base,
      planFile: item.planFile,
      round,
      seedUsed: cfg.seed + round,
      rules: cfg.rulesByRound[round - 1],
      confidenceMin: cfg.confidenceMin,
      seenDigest: digest(seen),
    })
    if (!review) {
      parkedReason = `code-review workflow failed on round ${round}`
      break
    }
    suggestions.push(...review.suggestions)
    if (review.converged) {
      converged = true
      break
    }
    for (const f of review.newConfirmed) seen.push({ ...f, round, status: 'open' })

    const fix = await agent(fixPrompt(item, review.newConfirmed, round), {
      label: `fix:${item.id}:r${round}`,
      phase: 'Fix',
      schema: IMPLEMENT_SCHEMA,
    })
    if (!fix || fix.status === 'blocked' || !fix.validations_green) {
      parkedReason = (fix && fix.blocker) || `fix agent failed on round ${round}`
      break
    }
    for (const f of seen) if (f.status === 'open') f.status = 'fixed'
  }

  if (converged) {
    return { item, outcome: 'done', roundsUsed, summary: state.summary, suggestions }
  }
  return {
    item,
    outcome: 'parked',
    roundsUsed,
    parkedReason: parkedReason || `code-review budget (${cfg.codeRounds}) exhausted with open findings: ${seen.filter(f => f.status === 'open').map(f => f.key).join(', ')}`,
    summary: state.summary,
    suggestions,
  }
}

log(`wave: ${cfg.items.map(i => i.id).join(', ')}`)
const results = await pipeline(cfg.items, implementStage, reviewFixLoop)

return results.filter(Boolean).map(r => ({
  id: r.item.id,
  outcome: r.outcome,
  roundsUsed: r.roundsUsed,
  parkedReason: r.parkedReason || null,
  summary: r.summary || null,
  suggestions: (r.suggestions || []).map(s => ({ key: s.key, what: s.what, location: s.location })),
}))
