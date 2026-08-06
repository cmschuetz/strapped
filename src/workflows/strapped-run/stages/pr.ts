// Stage: pr — stacked-PR create pass, gated on every in-scope node being
// done-or-later (the whole run by default; one deliverable under `only`).
// Chained after implement WITH the same scope, that stage's allDone already
// proved the gate; otherwise a fresh dag probe (scoped when `only` is set)
// must show no in-scope node earlier than done.

import { stageArgsFor } from '../config.ts'
import { PR_SCHEMA, PROBE_SCHEMA } from '../schemas.generated.ts'
import type { PrResult, PrStageResult, ProbeResult, RunConfig, StageCtx } from '../types.ts'

export async function prStage(cfg: RunConfig, ctx: StageCtx): Promise<PrStageResult> {
  const a = stageArgsFor(cfg, 'pr')
  const dryRun = Boolean(a.dryRun)
  const only = a.only || null
  const stateScript = cfg.scripts.state

  // Gate: every in-scope node must be done-or-later. Chained after implement
  // with the SAME scope, that stage's allDone already proved it (the dispatch
  // loop stops on !allDone); a chain whose implement scope differs from the
  // pr scope must re-probe, as must a dispatch that never ran implement.
  const implementOnly = stageArgsFor(cfg, 'implement').only || null
  if (!ctx.ranImplement || implementOnly !== only) {
    const notDoneDesc = only
      ? `"notDone": [<"${only}" when its status is NOT done/pr-open/merged, else nothing — the scope is ${only} alone>]`
      : '"notDone": [<the ids of the nodes whose status is NOT done/pr-open/merged>]'
    const probe = await agent<ProbeResult>(
      `You are a mechanical executor for strapped run "${cfg.slug}". Run exactly this command via Bash and return the JSON described (contract: the "Harness scripts" section of ${cfg.conventionsFile}):

node ${stateScript} dag ${cfg.dir}${only ? ` --only ${only}` : ''}

Return { "remaining": <the dag's remaining field verbatim — never recompute it>, ${notDoneDesc} }. Do not run anything else.`,
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

  const scopeNote = only
    ? `\nSCOPE — this dispatch is restricted to deliverable ${only}: limit candidates to ${only} PLUS any of its ANCESTORS that are \`status: done\` without a \`pr:\` URL (stack coherence — a scoped ship must not skip an unshipped done parent), still in \`topo\` order and still under the candidate rule above (parents all done/pr-open/merged) and the base rules. In step 4, refresh only the stack tables of the PRs this scope touches — the PR(s) created here plus the run's existing ancestor/descendant PRs.\n`
    : ''

  const result = await agent<PrResult>(
    `You are the PR stage of strapped run "${cfg.slug}". Create the stacked GitHub PRs for this run's done deliverables — mechanically, per the documented procedure. All state reads/writes go through the state script: \`node ${stateScript} <command> ...\` (contract in the "Harness scripts" section of ${cfg.conventionsFile}).

Procedure — the "Stacked PRs" section of ${cfg.conventionsFile} is authoritative; read it first:
1. Run \`node ${stateScript} resolve ${cfg.slug}\` for the repos map (each repo's absolute root) and \`node ${stateScript} dag ${cfg.dir}\` for the nodes and the authoritative \`topo\` order — never hand-roll either.
2. Candidates: \`status: done\` nodes whose parents are all done, pr-open, or merged, processed in \`topo\` order.
${scopeNote}3. Per candidate, in that deliverable's OWN repo (every git/gh operation pinned to it via \`git -C <repoRoot>\` / running gh inside <repoRoot>):
   - \`git -C <repoRoot> push -u origin <branch>\`
   - \`gh pr create --head <branch> --base <parent-branch-if-same-repo-else-main> --title "<conventional title>" --body-file <generated>\` — base per the cross-repo base rule (the parent deliverable's branch only when the parent is in the same repo; a root or cross-repo child bases on that repo's main). MERGED-PARENT CARVE-OUT: a same-repo parent whose status is \`merged\` has its work already in main and its local branch is a dead pre-merge tip — base the child's PR on the repo's **main** instead. When the child branch still contains the merged parent's pre-merge commits, rebase first: (a) \`git -C <repoRoot> fetch origin main\` so the rebase target actually contains the parent's squash merge; (b) run the rebase INSIDE the child's worktree, where the branch is already checked out — \`git -C <childWorktree> rebase --onto origin/main <parent-branch>\` — so only the child's own commits replay; NEVER \`git rebase main <branch>\` from outside the worktree (it implicitly checks out a branch held by the persistent worktree, targets a stale local main, and replays the squash-merged parent's commits); (c) resolve \`<parent-branch>\` from the child's frontmatter \`base:\`, falling back to the parent's pre-merge tip SHA via \`gh pr view <parent-pr> --json headRefOid\` when the local ref was deleted after merge; (d) push with \`-u\`/\`--force-with-lease\` per the Guardrails. Parents at \`done\`/\`pr-open\` keep the parent-branch base. Title and body follow the conventions' "PR titles and bodies (Conventional Commits)" spec, which is the DEFAULT and defers: if the repo config, the repo's CLAUDE.md, or the user's Claude settings/guidelines already establish a PR-title or commit convention, follow THAT and do not overwrite it; only when no such convention is supplied, default to the conventional format — title \`<type>(${cfg.slug}): <description>\` — scope is the run slug "${cfg.slug}", \`<type>\` chosen from the deliverable's primary nature (feat/fix/refactor/perf/docs/test/build/ci/chore per the rubric there; \`!\` before the colon for a breaking change), \`<description>\` an imperative, lower-case summary of THIS deliverable with no trailing period (NOT a \`<Did>:\`-prefixed title) — keep the title SHORT: aim ~50 chars for the whole line, hard ceiling ~72. Body: a blank line then imperative what/why prose in natural unwrapped paragraphs (never insert manual line breaks inside a paragraph — GitHub wraps prose itself), then the retained structured pieces — one-paragraph summary, the acceptance criteria as a checklist, a Stack table of the whole DAG grouped by repo, and \`Depends on #<parent PR>\` for same-repo non-roots — then footers (\`BREAKING CHANGE:\` when applicable).
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
