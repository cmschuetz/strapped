export const meta = {
  name: 'strapped-feedback-synth',
  description: 'Synthesize fetched PR review comments (line-anchored, review-submission bodies, global/issue) into ONE consolidated cross-deliverable set of `## Feedback addendum` sections on the EXISTING deliverable files, then run them through the shared review-loop.js adversarial review loop. Mints no new deliverables/branches/worktrees.',
  phases: [
    { title: 'Synthesize', detail: 'route each comment to the owning deliverable, write ## Feedback addendum sections' },
    { title: 'Review', detail: 'adversarial review of the amended deliverable set via review-loop.js' },
  ],
}

const cfg = typeof args === 'string' ? JSON.parse(args) : args

const repos =
  Array.isArray(cfg.repos) && cfg.repos.length
    ? cfg.repos
    : cfg.repoRoot
    ? [{ name: cfg.repoRoot.split('/').filter(Boolean).pop() || cfg.repoRoot, root: cfg.repoRoot }]
    : []

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['addenda', 'summary'],
  properties: {
    addenda: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['deliverableId', 'sourcePr', 'crossDeliverable', 'tasks'],
        properties: {
          deliverableId: { type: 'string' },
          sourcePr: { type: 'string' },
          crossDeliverable: { type: 'boolean' },
          tasks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    summary: { type: 'string' },
  },
}

phase('Synthesize')
const synth = await agent(
  `You are the PR-feedback synthesis agent for strapped run "${cfg.slug}". Turn fetched PR review comments into ONE consolidated, cross-deliverable set of fix tasks, each placed on the CORRECT existing deliverable.

State root for this run: ${cfg.dir}
- Read the DAG + repos map: ${cfg.dir}/manifest.md
- Read EVERY deliverable file under ${cfg.dir}/deliverables/ — each one's \`## Files to touch\` map tells you which files that deliverable owns, so you can route a comment's anchored file path to the deliverable that actually owns it (which may DIFFER from the PR the comment was left on).

Fetched PR review comments (grouped by the deliverable whose PR they were left on; each carries the anchored \`path\`/\`line\` where present, plus the three categories: line-anchored review comments, review-SUBMISSION bodies with their \`state\` — a CHANGES_REQUESTED/COMMENTED/APPROVED summary — and global/issue comments):
${JSON.stringify(cfg.comments, null, 2)}

Tasks:
1. For each comment (or cluster of related comments), decide which EXISTING deliverable should carry the fix. Use the anchored file path against each deliverable's \`Files to touch\` map — a comment left on a child PR may belong on its parent (or another node). A non-empty CHANGES_REQUESTED review-submission body states the overarching problem: treat it as GLOBAL feedback for that deliverable and route its implied fixes to the owning node(s).
2. Append a \`## Feedback addendum\` section to each affected deliverable's file at ${cfg.dir}/deliverables/<id>-*.md. The section lists concrete, in-scope fix tasks (imperative, testable), each referencing the originating comment/PR. Keep the file conformant to ${cfg.conventionsFile}. If a deliverable already has a \`## Feedback addendum\` section from a prior feedback pass, append new tasks under it rather than duplicating the heading.
3. Do NOT create new deliverable files, branches, or worktrees. Every fix attaches to an EXISTING deliverable.

Return, per affected deliverable: its id, the source PR the comments came from, whether any task was routed cross-deliverable (placed on a node different from the PR it was left on), and the list of tasks. Plus a one-paragraph summary of the consolidated feedback plan.`,
  { label: 'feedback-synth', schema: SYNTH_SCHEMA }
)
if (!synth) throw new Error('feedback synthesis agent failed')
log(`feedback addenda produced for ${synth.addenda.length} deliverable(s)`)

const review = await workflow(
  cfg.reviewLoopScript ? { scriptPath: cfg.reviewLoopScript } : 'strapped-review-loop',
  {
    slug: cfg.slug,
    dir: cfg.dir,
    ask: `The fetched PR review comments for strapped run "${cfg.slug}" (line-anchored review comments, review-submission bodies including CHANGES_REQUESTED summaries, and global/issue comments):\n${JSON.stringify(cfg.comments, null, 2)}`,
    artifactDescription: 'the amended deliverable set — every file in deliverables/ including the newly-added `## Feedback addendum` sections synthesized from the PR review comments',
    artifactLocation: 'every file in deliverables/ including the newly-added `## Feedback addendum` sections synthesized from the PR review comments',
    artifactNoun: 'deliverable set',
    refuteArtifactPhrase: 'the amended deliverable set',
    conventionsFile: cfg.conventionsFile,
    repos,
    repoRoot: cfg.repoRoot,
    seed: cfg.seed,
    maxRounds: cfg.maxRounds,
    rulesByRound: cfg.rulesByRound,
    confidenceMin: cfg.confidenceMin,
    roundFilePrefix: 'feedback-round',
  }
)
if (!review) throw new Error('review-loop workflow failed')

return {
  slug: cfg.slug,
  converged: review.converged,
  rounds: review.rounds,
  outstanding: review.outstanding,
  addenda: synth.addenda,
  summary: synth.summary,
}
