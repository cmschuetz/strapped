// Stage: plan — planner writes research/manifest/deliverables, then the
// bounded adversarial plan-review loop; a chained dispatch auto-approves the
// converged manifest (a singleton ["plan"] run leaves approval to the skill).

import { repoList, stageArgsFor } from '../config.ts'
import { runReviewLoop } from '../review-loop.ts'
import { APPROVE_SCHEMA, PLAN_SCHEMA } from '../schemas.generated.ts'
import type { ApproveResult, PlanResult, PlanStageResult, RunConfig, StageCtx } from '../types.ts'

export async function planStage(cfg: RunConfig, ctx: StageCtx): Promise<PlanStageResult> {
  const a = stageArgsFor(cfg, 'plan')
  const stateScript = cfg.scripts.state

  const plan = await agent<PlanResult>(
    `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

Source plan (the original ask): ${a.sourcePlan}
Target repos (the run state is keyed by the run slug, not by any repo; the work spans these repos — an unordered set):
${repoList(a.repos)}
Output directory (already scaffolded): ${cfg.dir}
Conventions you MUST follow for every file format: ${cfg.conventionsFile}

Procedure:
1. Read the source plan in full, then research each target repo's codebase thoroughly: architecture, the modules the ask touches, existing utilities to reuse, test patterns. Verify every repo claim against \`origin/main\` — \`git -C <repoRoot> fetch\` first, then read the fetched \`origin/main\`, NOT the local working tree, which may be behind. A plan written against a stale local checkout is a defect.
2. Write ${cfg.dir}/research.md — a distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see.
3. Split the work into deliverables by discrete theme, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR — split a theme into multiple deliverables only when its estimated meaningful diff (excluding generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures) exceeds ~1,000 changed lines. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs. Assign each deliverable to exactly one target repo. If a target repo has no real test suite and its only validations are heuristic syntax checks, make a proper test suite (per that project type's current standard) the FIRST deliverable and wire it in as the validation gate for the rest of the run — do not settle for the heuristics.
4. Write one self-contained file per deliverable at ${cfg.dir}/deliverables/<id>-<kebab>.md per the conventions (frontmatter: id, title, deps, repo: <one of the target repo names above>, status: pending, branch: strapped/${cfg.slug}/<id>-<kebab>, base, worktree: null, pr: null, review_rounds_used: 0, feedback_rounds_used: 0, parked_reason: null, estimated_diff_lines; body: Context slice from your research, Files to touch, Implementation steps, Acceptance criteria, Tests, Out of scope). Set base per the cross-repo base rule: a deliverable's base is a parent branch WITHIN THE SAME repo, otherwise that repo's main (roots, and any cross-repo child, base on their own repo's main — you can never branch across repos). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. Cross-repo deps are ordering-only, NEVER a code dependency: a cross-repo child bases on its own repo's main and does not have its parent's unmerged code. Reject or restructure any plan where a cross-repo child has a true code dependency on its parent — either require the shared change to merge to the parent repo's main first, or keep both sides in the same repo/chain.
6. Write ${cfg.dir}/manifest.md per the conventions (status: in-review, seed: ${cfg.seed}, budgets — record the EFFECTIVE budgets of this run: plan_rounds: ${cfg.planRounds}, code_rounds: ${cfg.codeRounds}, confidence_min: ${cfg.confidenceMin} — the repos: map listing every target repo above per the conventions — name, root, config path (repos: is an unordered set, no repo is special); the deliverables list with ids/files/repos/deps, theme summary, ASCII DAG sketch).

Return the deliverable list and a one-paragraph summary.`,
    { label: 'planner', schema: PLAN_SCHEMA }
  )
  if (!plan) throw new Error('plan stage: planner agent failed')
  log(`plan produced: ${plan.deliverables.length} deliverable(s)`)

  const review = await runReviewLoop(cfg, {
    ask: a.sourcePlan,
    repos: a.repos,
    artifactDescription: 'a produced implementation plan',
    artifactLocation: 'manifest.md, research.md, and every file in deliverables/',
    artifactNoun: 'plan',
    refuteArtifactPhrase: 'the implementation plan',
    roundFilePrefix: 'plan-round',
    maxRounds: cfg.planRounds,
    enumeratedItemsLabel: 'AC',
    enumeratedItemsSection: '## Acceptance criteria',
    reviserPromptFn: (newConfirmed, roundFile) =>
      `You are the plan reviser for strapped run "${cfg.slug}". Close every confirmed review finding by editing the plan files in ${cfg.dir} (manifest.md, research.md, deliverables/*.md), keeping every file conformant to ${cfg.conventionsFile}. Original ask for reference: ${a.sourcePlan}. Target repos (fix repo assignments and cross-repo base rules against these):
${repoList(a.repos)}

Confirmed findings to close (full bodies also in ${roundFile}):
${JSON.stringify(newConfirmed.map(f => ({ id: f.id, key: f.key, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

For each finding: apply the fix (this may mean splitting a deliverable that mixes unrelated themes or exceeds the ~1,000-line meaningful-diff threshold, adding a missing deliverable, fixing deps in BOTH the manifest and the deliverable frontmatter, adding acceptance criteria or tests, or correcting a wrong assumption after re-checking the code). Then update ${roundFile}: flip each addressed finding's status from open to fixed. Return one line per finding: id — what you changed.`,
  })

  // Auto-approval belongs ONLY to a chained dispatch — a singleton ["plan"]
  // run leaves approval to the skill's interactive gate.
  if (review.converged && ctx.hasLaterStage) {
    const approve = await agent<ApproveResult>(
      `You are a mechanical executor for strapped run "${cfg.slug}". Run exactly this command via Bash and return its JSON output (contract: the "Harness scripts" section of ${cfg.conventionsFile}):

node ${stateScript} manifest-status ${cfg.dir} approved

Return { "changed": <the command's changed field> }. Do not run anything else.`,
      { label: 'approve', effort: 'low', schema: APPROVE_SCHEMA }
    )
    if (!approve) throw new Error('plan stage: approve executor agent failed')
    log('plan converged — manifest approved for the chained stages')
  }

  return {
    converged: review.converged,
    rounds: review.rounds,
    deliverables: plan.deliverables,
    outstanding: review.outstanding,
    summary: plan.summary,
  }
}
