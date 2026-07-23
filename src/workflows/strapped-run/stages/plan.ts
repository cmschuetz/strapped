// Stage: plan — a research fan-out (scope agent, then bounded recursive
// researcher waves writing per-source digests) feeds the planner, which
// synthesizes research/manifest/deliverables; then the bounded adversarial
// plan-review loop; a chained dispatch auto-approves the converged manifest
// (a singleton ["plan"] run leaves approval to the skill).

import { repoList, stageArgsFor } from '../config.ts'
import { runReviewLoop } from '../review-loop.ts'
import { APPROVE_SCHEMA, PLAN_SCHEMA, RESEARCH_SCHEMA, SCOPE_SCHEMA } from '../schemas.generated.ts'
import type {
  ApproveResult,
  PlanResult,
  PlanStageArgs,
  PlanStageResult,
  ResearchResult,
  ResearchSource,
  RunConfig,
  ScopeResult,
  StageCtx,
} from '../types.ts'

/** Shared delegation grant for every research/planner prompt (AC7). */
const DELEGATION_GRANT =
  'Use every tool available to you — including the Task tool to spawn parallel subagents when the harness provides it, and remote access (`gh`, web fetch/search) for non-local sources.'

type ResearchStatus = 'ok' | 'failed' | 'unreachable'

interface ResearchedSource {
  source: ResearchSource
  status: ResearchStatus
}

/** Trimmed, trailing-slash-stripped location — the frontier's dedup key. */
function normalizeLocation(location: string): string {
  return location.trim().replace(/\/+$/, '')
}

/**
 * The research frontier: dedup by normalized location across visited+pending,
 * uniquify colliding ids (`-2`, `-3`, …) so agent labels and digest paths never
 * silently overwrite. EVERY enqueue (target-repo seed, scope merge, per-wave
 * newSources) goes through add().
 */
function makeFrontier() {
  const locations = new Set<string>()
  const ids = new Set<string>()
  const pending: ResearchSource[] = []
  return {
    add(source: ResearchSource): void {
      const location = normalizeLocation(source.location)
      if (locations.has(location)) return
      let id = source.id
      for (let n = 2; ids.has(id); n++) id = `${source.id}-${n}`
      locations.add(location)
      ids.add(id)
      pending.push({ ...source, id, location: source.location })
    },
    /** Drain the pending sources for the next wave. */
    take(): ResearchSource[] {
      return pending.splice(0)
    },
    /** Sources enqueued but never researched (budget exhausted). */
    leftovers(): readonly ResearchSource[] {
      return pending
    },
  }
}

function researcherPrompt(cfg: RunConfig, source: ResearchSource, sourcePlan: string | undefined): string {
  const digestFile = `${cfg.dir}/research/${source.id}.md`
  return `You are a research agent for strapped run "${cfg.slug}". Research this ONE source exhaustively for the ask.

Source plan (the original ask, for context): ${sourcePlan}
Your single source:
- id: ${source.id}
- kind: ${source.kind}
- name: ${source.name}
- location: ${source.location}
- why it matters: ${source.why}

Procedure:
1. Research the source exhaustively for the ask. For a local path, explore the codebase: architecture, the modules the ask touches, existing utilities to reuse, test patterns. For a URL/remote source, use whatever access is available (\`gh\`, web fetch/search). If NO access route works, set \`unreachable: true\`, write NO digest, and return \`digestFile: null\` with a \`summary\` saying why the source was unreachable.
2. Otherwise write a digest (~100 lines: the source's role, key files/APIs with one-line roles, findings relevant to the ask, pitfalls) to ${digestFile} (create the directory if needed) and return its absolute path as \`digestFile\`.
3. Report \`newSources\`: any FURTHER repos, docs, or data sources this source references that bear on the ask, each with a resolved location (absolute path or URL), a unique kebab-case id, and a one-line why.

${DELEGATION_GRANT} If the Task tool is unavailable, do the work directly — the workflow already parallelizes across sources.`
}

/** Run the pre-planner research fan-out; returns the researched-source table + leftovers. */
async function runResearchFanOut(
  cfg: RunConfig,
  a: PlanStageArgs
): Promise<{ researched: ResearchedSource[]; leftovers: readonly ResearchSource[] }> {
  phase('Research')
  const maxWaves = Math.max(1, Math.floor(a.researchWaves ?? 3))
  const frontier = makeFrontier()

  // The workflow seeds the target repos itself — coverage never depends on an
  // LLM enumeration.
  for (const repo of a.repos ?? []) {
    frontier.add({ id: repo.name, kind: 'repo', name: repo.name, location: repo.root, why: 'target repo' })
  }

  const scope = await agent<ScopeResult>(
    `You are the research-scope agent for strapped run "${cfg.slug}". Read the source plan at ${a.sourcePlan} and enumerate EVERY additional repo, directory, file, URL, API, or data source the plan mentions or implies BEYOND the target repos (list them all):
${repoList(a.repos)}

For each additional source: resolve repo names to absolute local paths where possible (siblings of the target repo roots, common project dirs), else record the best remote locator (URL, \`gh\` repo slug); give each a unique kebab-case id and a one-line why it matters to the ask. Return an empty list if the plan mentions no additional sources.`,
    { label: 'research-scope', effort: 'low', schema: SCOPE_SCHEMA }
  )
  if (scope) {
    for (const source of scope.sources) frontier.add(source)
  } else {
    log('plan research: scope agent failed — continuing with the target repos only')
  }

  const researched: ResearchedSource[] = []
  for (let wave = 1; wave <= maxWaves; wave++) {
    const batch = frontier.take()
    if (batch.length === 0) break
    const results = await parallel(
      batch.map(source => () =>
        agent<ResearchResult>(researcherPrompt(cfg, source, a.sourcePlan), {
          label: `research:${source.id}:w${wave}`,
          schema: RESEARCH_SCHEMA,
        })
      )
    )
    results.forEach((result, i) => {
      const source = batch[i]
      if (!source) return
      if (!result) {
        log(`plan research: researcher for ${source.id} failed — continuing without its digest`)
        researched.push({ source, status: 'failed' })
        return
      }
      researched.push({ source, status: result.unreachable || !result.digestFile ? 'unreachable' : 'ok' })
      for (const discovered of result.newSources) frontier.add(discovered)
    })
  }

  const leftovers = frontier.leftovers()
  if (leftovers.length) {
    log(`plan research: wave budget (${maxWaves}) exhausted — un-researched: ${leftovers.map(s => s.id).join(', ')}`)
  }
  const bad = researched.filter(r => r.status !== 'ok')
  if (bad.length) {
    log(`plan research: sources without digests: ${bad.map(r => `${r.source.id} (${r.status})`).join(', ')}`)
  }
  return { researched, leftovers }
}

export async function planStage(cfg: RunConfig, ctx: StageCtx): Promise<PlanStageResult> {
  const a = stageArgsFor(cfg, 'plan')
  const stateScript = cfg.scripts.state

  const { researched, leftovers } = await runResearchFanOut(cfg, a)

  const sourceTable = researched
    .map(r => `- ${r.source.id} (${r.source.kind}) at ${r.source.location} — ${r.status}`)
    .join('\n')
  const leftoverLines = leftovers.length
    ? leftovers.map(s => `- ${s.id} (${s.kind}) at ${s.location} — un-researched (wave budget exhausted)`).join('\n')
    : '(none)'

  const plan = await agent<PlanResult>(
    `You are the planning agent for strapped run "${cfg.slug}". Produce a complete, reviewable implementation plan from a large source plan document.

Source plan (the original ask): ${a.sourcePlan}
Target repos (the run state is keyed by the run slug, not by any repo; the work spans these repos — an unordered set):
${repoList(a.repos)}
Output directory (already scaffolded): ${cfg.dir}
Conventions you MUST follow for every file format: ${cfg.conventionsFile}

A research fan-out already ran: per-source digests live under ${cfg.dir}/research/ (one <sourceId>.md per ok source). Researched sources (ok = digest written; failed = researcher agent failed, no digest; unreachable = source inaccessible, no digest):
${sourceTable || '(no sources were researched)'}
Un-researched leftovers (discovered but never researched — the wave budget ran out):
${leftoverLines}

${DELEGATION_GRANT} That includes Task subagents for any remaining research gap.

Procedure:
1. Read the source plan in full, then read every per-source digest under ${cfg.dir}/research/. Verify and deepen findings in the target repos directly as needed — especially for any failed, unreachable, or un-researched source above.
2. Write ${cfg.dir}/research.md — a distilled digest (~300 lines max) synthesized from the per-source digests: architecture notes, key files with one-line roles, library/API findings, decisions with rationale, known pitfalls. Cover the failed/unreachable/un-researched sources explicitly (what is missing and how you compensated) so nothing silently disappears. This is the only research context implementers will ever see.
3. Split the work into deliverables by discrete theme, forming a DAG: independent work has no deps, dependent work lists its parent deliverable ids. Keep one coherent theme in a single deliverable so a reviewer can grasp the whole change in one PR — split a theme into multiple deliverables only when its estimated meaningful diff (excluding generated code, dependency/lockfile bumps, generated clients/schemas, vendored code, and large fixtures) exceeds ~1,000 changed lines. Prefer a few cohesive, independently-shippable nodes over many fragments that scatter one theme across PRs. Assign each deliverable to exactly one target repo.
4. Write one self-contained file per deliverable at ${cfg.dir}/deliverables/<id>-<kebab>.md per the conventions (frontmatter: id, title, deps, repo: <one of the target repo names above>, status: pending, branch: strapped/${cfg.slug}/<id>-<kebab>, base, worktree: null, pr: null, review_rounds_used: 0, feedback_rounds_used: 0, parked_reason: null, estimated_diff_lines; body: Context slice from your research, Files to touch, Implementation steps, Acceptance criteria, Tests, Out of scope). Set base per the cross-repo base rule: a deliverable's base is a parent branch WITHIN THE SAME repo, otherwise that repo's main (roots, and any cross-repo child, base on their own repo's main — you can never branch across repos). A fresh implementer seeded with ONLY this file plus research.md must be able to do the work.
5. Cross-repo deps are ordering-only, NEVER a code dependency: a cross-repo child bases on its own repo's main and does not have its parent's unmerged code. Reject or restructure any plan where a cross-repo child has a true code dependency on its parent — either require the shared change to merge to the parent repo's main first, or keep both sides in the same repo/chain.
6. Write ${cfg.dir}/manifest.md per the conventions (status: in-review, seed: ${cfg.seed}, budgets — record the EFFECTIVE budgets of this run: plan_rounds: ${cfg.planRounds}, code_rounds: ${cfg.codeRounds}, confidence_min: ${cfg.confidenceMin} — the repos: map listing every target repo above per the conventions — name, root, config path (repos: is an unordered set, no repo is special); the deliverables list with ids/files/repos/deps, theme summary, ASCII DAG sketch).
7. After all plan artifacts are written, run \`node ${stateScript} commit ${cfg.dir}\` via Bash so the run's state root is git-backed from birth (it git-inits the state root if absent and commits the artifacts). Best-effort: proceed even if it reports an error.

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
