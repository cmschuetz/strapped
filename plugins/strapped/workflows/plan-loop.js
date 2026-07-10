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

phase('Plan')
const plan = await agent(
  `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

Source plan (the original ask): ${cfg.sourcePlan}
Target repos (the run state is keyed by the run slug, not by any repo; the work spans these repos — an unordered set):
${repoList()}
Output directory (already scaffolded): ${cfg.dir}
Conventions you MUST follow for every file format: ${cfg.conventionsFile}

Procedure:
1. Read the source plan in full, then research each target repo's codebase thoroughly: architecture, the modules the ask touches, existing utilities to reuse, test patterns.
2. Write ${cfg.dir}/research.md — a distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see.
3. Split the work into deliverables by discrete theme, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR — split a theme into multiple deliverables only when its estimated meaningful diff (excluding generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures) exceeds ~1,000 changed lines. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs. Assign each deliverable to exactly one target repo.
4. Write one self-contained file per deliverable at ${cfg.dir}/deliverables/<id>-<kebab>.md per the conventions (frontmatter: id, title, deps, repo: <one of the target repo names above>, status: pending, branch: strapped/${cfg.slug}/<id>-<kebab>, base, worktree: null, pr: null, review_rounds_used: 0, parked_reason: null, estimated_diff_lines; body: Context slice from your research, Files to touch, Implementation steps, Acceptance criteria, Tests, Out of scope). Set base per the cross-repo base rule: a deliverable's base is a parent branch WITHIN THE SAME repo, otherwise that repo's main (roots, and any cross-repo child, base on their own repo's main — you can never branch across repos). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. Cross-repo deps are ordering-only, NEVER a code dependency: a cross-repo child bases on its own repo's main and does not have its parent's unmerged code. Reject or restructure any plan where a cross-repo child has a true code dependency on its parent — either require the shared change to merge to the parent repo's main first, or keep both sides in the same repo/chain.
6. Write ${cfg.dir}/manifest.md per the conventions (status: in-review, seed: ${cfg.seed}, the repos: map listing every target repo above per the conventions — name, root, config path (repos: is an unordered set, no repo is special); the deliverables list with ids/files/repos/deps, theme summary, ASCII DAG sketch).

Return the deliverable list and a one-paragraph summary.`,
  { label: 'planner', schema: PLAN_SCHEMA }
)
if (!plan) throw new Error('planner agent failed')
log(`plan produced: ${plan.deliverables.length} deliverable(s)`)

const review = await workflow(
  cfg.reviewLoopScript ? { scriptPath: cfg.reviewLoopScript } : 'strapped-review-loop',
  {
    slug: cfg.slug,
    dir: cfg.dir,
    ask: cfg.sourcePlan,
    conventionsFile: cfg.conventionsFile,
    repos,
    repoRoot: cfg.repoRoot,
    seed: cfg.seed,
    maxRounds: cfg.maxRounds,
    rulesByRound: cfg.rulesByRound,
    confidenceMin: cfg.confidenceMin,
    roundFilePrefix: 'plan-round',
  }
)
if (!review) throw new Error('review-loop workflow failed')

return {
  slug: cfg.slug,
  converged: review.converged,
  rounds: review.rounds,
  deliverables: plan.deliverables,
  outstanding: review.outstanding,
  summary: plan.summary,
}
