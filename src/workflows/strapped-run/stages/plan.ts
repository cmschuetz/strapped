// Stage: plan — planner writes research/manifest/deliverables (optionally
// delegating research topics to parallel researcher agents in a bounded BFS
// fan-out, consolidated by a plan-writer), then the bounded adversarial
// plan-review loop; a chained dispatch auto-approves the converged manifest
// (a singleton ["plan"] run leaves approval to the skill).

import { repoList, stageArgsFor } from '../config.ts'
import { runReviewLoop } from '../review-loop.ts'
import {
  APPROVE_SCHEMA,
  PLAN_LEAD_SCHEMA,
  PLAN_SCHEMA,
  RESEARCH_FINAL_SCHEMA,
  RESEARCH_SCHEMA,
} from '../schemas.generated.ts'
import type {
  ApproveResult,
  PlanLeadResult,
  PlanResult,
  PlanStageArgs,
  PlanStageResult,
  ResearchFinalResult,
  ResearchRequest,
  ResearchResult,
  RunConfig,
  StageCtx,
} from '../types.ts'

/** Hard per-round researcher clamp — guards against liberal delegation. */
const MAX_RESEARCH_PER_ROUND = 6

/** Lowercase kebab slug of a research topic (dedup + label + fragment filename key). */
function slugifyTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

interface AssignedTopic {
  slug: string
  topic: string
  brief: string
}

/** Slugify + dedup requests against already-assigned slugs and within the batch. */
function uniqueRequests(requests: readonly ResearchRequest[], seen: ReadonlySet<string>): AssignedTopic[] {
  const out: AssignedTopic[] = []
  const local = new Set<string>()
  for (const req of requests) {
    const slug = slugifyTopic(req.topic ?? '')
    if (slug === '' || seen.has(slug) || local.has(slug)) continue
    local.add(slug)
    out.push({ slug, topic: req.topic, brief: req.brief ?? '' })
  }
  return out
}

/** The input block shared by the planner (classic + lead) and plan-writer prompts. */
function plannerInputs(cfg: RunConfig, a: PlanStageArgs): string {
  return `Source plan (the original ask): ${a.sourcePlan}
Target repos (the run state is keyed by the run slug, not by any repo; the work spans these repos — an unordered set):
${repoList(a.repos)}
Output directory (already scaffolded): ${cfg.dir}
Conventions you MUST follow for every file format: ${cfg.conventionsFile}`
}

/** Steps 1–2 of the planner procedure (research + digest), shared classic/lead. */
function researchSteps(cfg: RunConfig): string {
  return `1. Read the source plan in full, then research each target repo's codebase thoroughly: architecture, the modules the ask touches, existing utilities to reuse, test patterns.
2. Write ${cfg.dir}/research.md — a distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see.`
}

/**
 * Steps 3–7 of the planner procedure (deliverables, preconditions, manifest,
 * state commit) — shared VERBATIM by the classic prompt, the lead prompt, and
 * the plan-writer prompt, so every manifest-writing path records the same
 * budgets (including research_rounds) and keeps the preconditions contract.
 */
function planWritingSteps(cfg: RunConfig): string {
  const stateScript = cfg.scripts.state
  return `3. Split the work into deliverables by discrete theme, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR — split a theme into multiple deliverables only when its estimated meaningful diff (excluding generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures) exceeds ~1,000 changed lines. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs. Assign each deliverable to exactly one target repo.
4. Write one self-contained file per deliverable at ${cfg.dir}/deliverables/<id>-<kebab>.md per the conventions (ids are EXACTLY D1, D2, D3, ... — capital D then the ordinal, in filenames, frontmatter, branches, and deps alike) (frontmatter: id, title, deps, repo: <one of the target repo names above>, status: pending, branch: strapped/${cfg.slug}/<id>-<kebab>, base, worktree: null, pr: null, review_rounds_used: 0, feedback_rounds_used: 0, parked_reason: null, estimated_diff_lines; body sections under these EXACT verbatim headers — \`## Context\`, \`## Files to touch\`, \`## Implementation steps\`, \`## Acceptance criteria\`, \`## Tests\`, \`## Out of scope\` — the review machinery keys on the \`## Acceptance criteria\` header literally, so no case or wording variation; a deliverable covered by step 5 additionally carries a \`## Preconditions\` section). Set base per the cross-repo base rule: a deliverable's base is a parent branch WITHIN THE SAME repo, otherwise that repo's main (roots, and any cross-repo child, base on their own repo's main — you can never branch across repos). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. A deliverable MAY depend on a parent whose work must first become available to it through some external landing step outside this run's control (a cross-repo child bases on its own repo's main and never has a sibling repo's unmerged branch). Plan such work IN the DAG anyway — never push it out of the plan as an out-of-band follow-up. Record the prerequisite in the child's body under a \`## Preconditions\` section (a short note stating what must be TRUE before implementation can start — checkable, not aspirational); at implement time an unmet precondition parks the node for a later re-kick instead of blocking the plan.
6. Write ${cfg.dir}/manifest.md per the conventions (status: in-review, seed: ${cfg.seed}, budgets — record the EFFECTIVE budgets of this run: plan_rounds: ${cfg.planRounds}, code_rounds: ${cfg.codeRounds}, research_rounds: ${cfg.researchRounds}, confidence_min: ${cfg.confidenceMin} — the repos: map listing every target repo above per the conventions — name, root, config path (repos: is an unordered set, no repo is special); the deliverables list with ids/files/repos/deps, theme summary, ASCII DAG sketch).
7. After all plan artifacts are written, run \`node ${stateScript} commit ${cfg.dir}\` via Bash so the run's state root is git-backed from birth (it git-inits the state root if absent and commits the artifacts). Best-effort: proceed even if it reports an error.`
}

/** The classic single-planner prompt (researchRounds === 1 — no delegation concept). */
function classicPlannerPrompt(cfg: RunConfig, a: PlanStageArgs): string {
  return `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

${plannerInputs(cfg, a)}

Procedure:
${researchSteps(cfg)}
${planWritingSteps(cfg)}

Return the deliverable list and a one-paragraph summary.`
}

/** The research-lead planner prompt (researchRounds > 1 — delegation available). */
function leadPlannerPrompt(cfg: RunConfig, a: PlanStageArgs): string {
  return `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

${plannerInputs(cfg, a)}

Research delegation: this run budgets ${cfg.researchRounds} BFS research rounds, counting your own research as round 1. You may enqueue research topics via research_requests; each becomes a delegated researcher agent running in its own isolated context, writing a fragment file under ${cfg.dir}/research/. Treat enqueueing a research task exactly as you would treat spawning a research subagent if you had that capability — the same judgment and the same restraint: delegation is for discrete topics that genuinely benefit from an isolated context window, and liberal delegation wastes tokens and wall clock. Most asks need no delegation at all.

Procedure (steps 2–7 apply only when you return an EMPTY research_requests list):
${researchSteps(cfg)}
${planWritingSteps(cfg)}

Delegation exit — when you return a NON-EMPTY research_requests list, replace steps 2–7 with: write ONLY your own round-1 findings as fragment files under ${cfg.dir}/research/<topic-slug>.md (lowercase kebab slug of each fragment's topic), write NO research.md, NO manifest.md, and NO deliverables/ files (a plan-writer agent consolidates every fragment and writes those after the delegated research rounds finish), and return empty deliverables plus research_requests (one { topic, brief } per delegated topic — the brief tells that researcher what to find out and why).

Return the deliverable list and a one-paragraph summary (deliverables is empty on the delegation exit).`
}

/** One delegated researcher's prompt; final-round prompts carry no enqueue concept. */
function researcherPrompt(
  cfg: RunConfig,
  a: PlanStageArgs,
  t: AssignedTopic,
  otherTopics: readonly string[],
  round: number,
  isFinal: boolean
): string {
  const fragment = `${cfg.dir}/research/${t.slug}.md`
  const ownership =
    otherTopics.length === 0
      ? ''
      : `\nThese topics are already owned by other researchers: ${otherTopics.join(', ')}; stay focused on your own topic — you may read their fragments under ${cfg.dir}/research/ for context, but don't duplicate their work in yours.\n`
  const enqueueStep = isFinal
    ? ''
    : `\n3. You MAY request further research for the next round by returning research_requests (one { topic, brief } per topic). Treat enqueueing a research task exactly as you would treat spawning a research subagent if you had that capability — the same judgment and the same restraint: most topics need no further delegation, so return an empty list unless a discrete sub-topic genuinely needs its own isolated context.`
  const returnLine = isFinal
    ? `Return { topic, notes_file, summary } — topic "${t.slug}", notes_file "${fragment}", and a one-paragraph summary of your findings.`
    : `Return { topic, notes_file, summary, research_requests } — topic "${t.slug}", notes_file "${fragment}", a one-paragraph summary of your findings, and research_requests (empty unless step 3 applies).`
  return `You are a delegated research agent for strapped run "${cfg.slug}" (plan-stage research round ${round} of ${cfg.researchRounds}). Research exactly ONE topic in this isolated context and write your findings as a fragment file.

Your topic: ${t.topic}
Brief from the lead: ${t.brief}

Source plan (the original ask): ${a.sourcePlan}
Target repos (an unordered set — the work spans these repos):
${repoList(a.repos)}
Run directory: ${cfg.dir}
${ownership}
Procedure:
1. Research your topic thoroughly across the target repos and the source plan: architecture, the modules the topic touches, key files, existing utilities to reuse, library/API findings, pitfalls.
2. Write ${fragment} — a distilled, self-contained fragment (~100 lines max): key files with one-line roles, findings, decisions with rationale, known pitfalls. It will be consolidated into the run's research digest, so keep it scoped to your topic.${enqueueStep}

${returnLine}`
}

/** The plan-writer prompt: consolidate fragments, then the classic steps 3–7 verbatim. */
function planWriterPrompt(cfg: RunConfig, a: PlanStageArgs): string {
  return `You are the plan-writer for strapped run "${cfg.slug}". The planning lead and its delegated researchers have finished their research; consolidate it and produce the complete, reviewable implementation plan.

${plannerInputs(cfg, a)}

Procedure:
1. Read the source plan in full, then read EVERY research fragment under ${cfg.dir}/research/ — the lead's own findings plus each delegated researcher's fragment.
2. Write ${cfg.dir}/research.md — consolidate the fragments into one distilled digest (~300 lines max): architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. This is the only research context implementers will ever see. Then perform steps 3–7:
${planWritingSteps(cfg)}

Return the deliverable list and a one-paragraph summary.`
}

/**
 * Rounds 2..researchRounds of the BFS research fan-out: slugified, deduped,
 * clamped researcher dispatches per round via parallel(). The final round is
 * harness-barred from enqueueing (RESEARCH_FINAL_SCHEMA + an enqueue-free
 * prompt), so the loop can never exceed the budget regardless of agent output.
 */
async function runResearchRounds(cfg: RunConfig, a: PlanStageArgs, initial: readonly ResearchRequest[]): Promise<void> {
  const seen = new Set<string>()
  let pending = uniqueRequests(initial, seen)
  for (let round = 2; round <= cfg.researchRounds && pending.length > 0; round++) {
    const batch = pending.slice(0, MAX_RESEARCH_PER_ROUND)
    const dropped = pending.slice(MAX_RESEARCH_PER_ROUND)
    if (dropped.length > 0) {
      log(
        `plan research round ${round}: clamped to ${MAX_RESEARCH_PER_ROUND} researchers — dropped ${dropped.map(t => t.slug).join(', ')}`
      )
    }
    for (const t of batch) seen.add(t.slug)
    const isFinal = round === cfg.researchRounds
    const results = await parallel(
      batch.map(t => () => {
        const others = [...seen].filter(s => s !== t.slug)
        return agent<ResearchResult | ResearchFinalResult>(researcherPrompt(cfg, a, t, others, round, isFinal), {
          label: `researcher:${t.slug}`,
          schema: isFinal ? RESEARCH_FINAL_SCHEMA : RESEARCH_SCHEMA,
        })
      })
    )
    const nextRequests: ResearchRequest[] = []
    for (let i = 0; i < batch.length; i++) {
      const t = batch[i]
      if (t === undefined) continue
      const result = results[i]
      if (result === null || result === undefined) {
        log(`plan research round ${round}: researcher ${t.slug} returned no result — skipped`)
        continue
      }
      if (!isFinal) nextRequests.push(...((result as ResearchResult).research_requests ?? []))
    }
    pending = isFinal ? [] : uniqueRequests(nextRequests, seen)
  }
}

export async function planStage(cfg: RunConfig, ctx: StageCtx): Promise<PlanStageResult> {
  const a = stageArgsFor(cfg, 'plan')
  const stateScript = cfg.scripts.state
  const delegating = cfg.researchRounds > 1

  const plan = await agent<PlanResult | PlanLeadResult>(
    delegating ? leadPlannerPrompt(cfg, a) : classicPlannerPrompt(cfg, a),
    { label: 'planner', schema: delegating ? PLAN_LEAD_SCHEMA : PLAN_SCHEMA }
  )
  if (!plan) throw new Error('plan stage: planner agent failed')

  const requests = delegating ? ((plan as PlanLeadResult).research_requests ?? []) : []
  let deliverables = plan.deliverables
  let summary = plan.summary
  if (requests.length > 0) {
    log(`plan delegating research: ${requests.length} request(s)`)
    await runResearchRounds(cfg, a, requests)
    const written = await agent<PlanResult>(planWriterPrompt(cfg, a), { label: 'plan-writer', schema: PLAN_SCHEMA })
    if (!written) throw new Error('plan stage: plan-writer agent failed')
    deliverables = written.deliverables
    summary = written.summary
  }
  log(`plan produced: ${deliverables.length} deliverable(s)`)

  const review = await runReviewLoop(cfg, {
    ask: a.sourcePlan,
    repos: a.repos,
    artifactDescription: 'a produced implementation plan',
    artifactLocation: 'manifest.md, research.md, and every file in deliverables/',
    artifactNoun: 'plan',
    verifyArtifactPhrase: 'the implementation plan',
    roundFilePrefix: 'plan-round',
    maxRounds: cfg.planRounds,
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
    deliverables,
    outstanding: review.outstanding,
    summary,
  }
}
