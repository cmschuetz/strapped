// Stage: pr — stacked-PR create pass, gated on every node being done-or-later.
// Chained after implement, that stage's allDone already proved the gate;
// otherwise a fresh dag probe must show no node earlier than done.

import { stageArgsFor } from '../config.ts'
import { PR_SCHEMA, PROBE_SCHEMA } from '../schemas.generated.ts'
import type { PrResult, PrStageResult, ProbeResult, RunConfig, StageCtx } from '../types.ts'

export async function prStage(cfg: RunConfig, ctx: StageCtx): Promise<PrStageResult> {
  const a = stageArgsFor(cfg, 'pr')
  const dryRun = Boolean(a.dryRun)
  const stateScript = cfg.scripts.state

  // Gate: every node must be done-or-later. Chained after implement, that
  // stage's allDone already proved it (the dispatch loop stops on !allDone);
  // otherwise a fresh dag probe must show no node earlier than done.
  if (!ctx.ranImplement) {
    const probe = await agent<ProbeResult>(
      `You are a mechanical executor for strapped run "${cfg.slug}". Run exactly this command via Bash and return the JSON described (contract: the "Harness scripts" section of ${cfg.conventionsFile}):

node ${stateScript} dag ${cfg.dir}

Return { "remaining": <the dag's remaining field verbatim — never recompute it>, "notDone": [<the ids of the nodes whose status is NOT done/pr-open/merged>] }. Do not run anything else.`,
      { label: 'pr-gate', phase: 'PR', effort: 'low', schema: PROBE_SCHEMA }
    )
    if (!probe) throw new Error('pr stage: dag probe agent failed')
    if (probe.remaining > 0) {
      log(`pr stage gate failed: ${probe.remaining} node(s) not yet done`)
      return {
        gateFailed: true,
        notDone: probe.notDone,
        prs: [],
        dryRun,
        summary: `pr stage did not run: ${probe.remaining} node(s) not yet done — ${probe.notDone.join(', ')}`,
      }
    }
  }

  const result = await agent<PrResult>(
    `You are the PR stage of strapped run "${cfg.slug}". Create the stacked GitHub PRs for this run's done deliverables — mechanically, per the documented procedure. All state reads/writes go through the state script: \`node ${stateScript} <command> ...\` (contract in the "Harness scripts" section of ${cfg.conventionsFile}).

Procedure — the "Stacked PRs" section of ${cfg.conventionsFile} is authoritative; read it first:
1. Run \`node ${stateScript} resolve ${cfg.slug}\` for the repos map (each repo's absolute root) and \`node ${stateScript} dag ${cfg.dir}\` for the nodes and the authoritative \`topo\` order — never hand-roll either.
2. Candidates: \`status: done\` nodes whose parents are all done, pr-open, or merged, processed in \`topo\` order.
3. Per candidate, in that deliverable's OWN repo (every git/gh operation pinned to it via \`git -C <repoRoot>\` / running gh inside <repoRoot>):
   - \`git -C <repoRoot> push -u origin <branch>\`
   - \`gh pr create --head <branch> --base <parent-branch-if-same-repo-else-main> --title "<Did>: <title>" --body-file <generated>\` — base per the cross-repo base rule (the parent deliverable's branch only when the parent is in the same repo; a root or cross-repo child bases on that repo's main). Body: one-paragraph summary, the acceptance criteria as a checklist, a Stack table of the whole DAG grouped by repo, and \`Depends on #<parent PR>\` for same-repo non-roots.
   - Record via the state script: \`node ${stateScript} set <deliverableFile> pr <url>\` then \`node ${stateScript} transition <deliverableFile> pr-open\`.
4. After all creations, refresh every stack table via \`gh pr edit <num> --body-file <regenerated>\` so earlier PRs link the later ones.

Guardrails (binding):
- Never push \`main\`, never merge PRs, never \`--force\` (only \`--force-with-lease\`) — enforced per repo (every git op runs \`-C <deliverableRepoRoot>\`).
- If \`gh\` is unauthenticated or a branch has no commits beyond its base, report and skip that node rather than failing the stage: return it with \`skipped: true\` and a human-readable \`reason\`, and continue with the remaining nodes.
${dryRun ? '\nDRY RUN — print-only: execute NOTHING that mutates (no push, no pr create/edit, no state-script set/transition). Print every would-be git/gh/state command, return them in `summary`, and return every candidate with `url: null` and `skipped: true`.\n' : ''}
Return \`prs\` — one entry per candidate node \`{ id, url, skipped, reason }\` (\`url\` null when skipped, \`reason\` null when created) — and a one-paragraph \`summary\` of what was created and what was skipped.`,
    { label: 'pr-create', phase: 'PR', schema: PR_SCHEMA }
  )
  if (!result) throw new Error('pr stage: pr agent failed')
  log(`pr stage: ${result.prs.length} node(s) processed${dryRun ? ' (dry run)' : ''}`)

  return { prs: result.prs, summary: result.summary, dryRun }
}
