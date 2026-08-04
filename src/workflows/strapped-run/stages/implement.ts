// Stage: implement — DAG wave loop: coordinator executor per pass, fresh
// implementer per node, bounded code-review/fix rounds (implement-review.ts),
// outcome applier. Park-don't-spin: zero newly-done progress stops the loop.

import { stageArgsFor } from '../config.ts'
import { APPLY_SCHEMA, IMPLEMENT_SCHEMA, WAVE_SCHEMA } from '../schemas.generated.ts'
import { runCodeReviewRound } from './implement-review.ts'
import type {
  ApplyResult,
  BlockedNode,
  CodeFinding,
  CoordinatorCtx,
  ImplementResult,
  ImplementStageResult,
  NodeOutcome,
  NodeState,
  ProcessedOutcome,
  RoundsField,
  RunConfig,
  SeenFinding,
  WaveItem,
  WaveResult,
} from '../types.ts'

function implementPrompt(cfg: RunConfig, item: WaveItem, addendumMode: boolean): string {
  if (addendumMode) {
    return `You are the fix agent applying PR-review feedback to deliverable ${item.id} of strapped run "${cfg.slug}". This deliverable was ALREADY implemented on its branch; you are NOT re-implementing it from scratch.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read your deliverable plan in full: ${item.planFile} — focus on its \`## Feedback addendum\` section, which lists the concrete fix tasks synthesized from the PR review comments.
2. Read the shared research digest: ${cfg.dir}/research.md
3. Read the project guidelines: every CLAUDE.md that applies (repo root at minimum).
${item.resumeNote ? `\nThis deliverable is being RESUMED. Prior state:\n${item.resumeNote}\n` : ''}
Apply ONLY the \`## Feedback addendum\` section to the EXISTING code on this branch — a targeted change addressing the review feedback. Do NOT re-implement the deliverable from scratch and do NOT touch anything outside the addendum's scope. Note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit your work on ${item.branch} with a Conventional-Commits message (\`<type>(${cfg.slug}): <description>\` — scope is the run slug, no \`${item.id}:\` title prefix; reference ${item.id} and the feedback fix in the body). If validations pass, commit and return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (contradictory addendum, validation failure you cannot fix), commit what is safe, return status "blocked" with the blocker described — do NOT loop indefinitely.`
  }
  return `You are the implementation agent for deliverable ${item.id} of strapped run "${cfg.slug}". You have fresh context — everything you need is in the files below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read your deliverable plan in full: ${item.planFile}
2. Read the shared research digest: ${cfg.dir}/research.md
3. Read the project guidelines: every CLAUDE.md that applies (repo root at minimum).
${item.resumeNote ? `\nThis deliverable is being RESUMED. Prior state:\n${item.resumeNote}\n` : ''}
Implement exactly what the plan specifies — its acceptance criteria are the contract. Write the tests the plan names (integration-style, public interfaces). Stay in scope: anything under "Out of scope" is off limits; note side-discoveries in your summary instead of fixing them.

Before finishing, ALL validations must pass inside the worktree:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit your work on ${item.branch} with a Conventional-Commits message (\`<type>(${cfg.slug}): <description>\` — scope is the run slug, no \`${item.id}:\` title prefix; reference ${item.id} in the body). If validations pass, commit and return status "implemented" with validations_green true. If you hit a blocker you cannot resolve (missing dependency, contradictory plan, validation failure you cannot fix), commit what is safe, return status "blocked" with the blocker described — do NOT loop indefinitely.`
}

function fixPrompt(cfg: RunConfig, item: WaveItem, findings: readonly CodeFinding[], round: number, recordSuffix: string): string {
  return `You are the fix agent for deliverable ${item.id} of strapped run "${cfg.slug}", code-review round ${round}. Fresh context — everything you need is below.

Work EXCLUSIVELY inside the worktree: ${item.worktree} (branch ${item.branch}, based on ${item.base}). This deliverable targets repo "${item.repo}" — never touch ${item.repoRoot} directly.

1. Read the deliverable plan: ${item.planFile}
2. Read the research digest: ${cfg.dir}/research.md
3. Read the full round record: ${cfg.dir}/reviews/${item.id}-code-round-${round}${recordSuffix}.md

Confirmed findings you must fix:
${JSON.stringify(findings.map(f => ({ id: f.id, key: f.key, severity: f.severity, location: f.location, what: f.what, recommendation: f.recommendation })), null, 2)}

Fix every finding. Then re-run ALL validations inside the worktree until green:
${item.validations.map(v => `- ${v}`).join('\n')}

Commit the fixes on ${item.branch}. Update the round record: flip each fixed finding's status from open to fixed. Return status "implemented" with validations_green true, or "blocked" with the blocker if a finding cannot be fixed as recommended (do not silently skip it).`
}

async function implementOne(cfg: RunConfig, item: WaveItem, addendumMode: boolean): Promise<NodeState> {
  const result = await agent<ImplementResult>(implementPrompt(cfg, item, addendumMode), {
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

async function reviewFixLoop(cfg: RunConfig, state: NodeState, recordSuffix: string): Promise<NodeOutcome> {
  if (state.outcome === 'parked') return { ...state, suggestions: [] }
  const item = state.item
  // A 0-round code-review budget means "skip adversarial review entirely and
  // trust the implementer" (its validations already ran green) — the node goes
  // straight to done and the confirmation pass never fires.
  if (cfg.codeRounds === 0) {
    log(`${item.id}: code-review budget 0 — skipping adversarial review`)
    return { item, outcome: 'done', roundsUsed: 0, summary: state.summary, suggestions: [] }
  }
  const seen: SeenFinding[] = []
  const suggestions: CodeFinding[] = []
  let converged = false
  let roundsUsed = 0
  let parkedReason: string | null = null

  let lastRoundFixedAll = false
  for (let round = 1; round <= cfg.codeRounds; round++) {
    roundsUsed = round
    lastRoundFixedAll = false
    const review = await runCodeReviewRound(cfg, { item, round, confirmation: false, seen, recordSuffix })
    suggestions.push(...review.suggestions)
    if (review.converged) {
      converged = true
      break
    }
    for (const f of review.newConfirmed) seen.push({ ...f, round, status: 'open' })

    const fix = await agent<ImplementResult>(fixPrompt(cfg, item, review.newConfirmed, round, recordSuffix), {
      label: `fix:${item.id}:r${round}`,
      phase: 'Fix',
      schema: IMPLEMENT_SCHEMA,
    })
    if (!fix || fix.status === 'blocked' || !fix.validations_green) {
      parkedReason = (fix && fix.blocker) || `fix agent failed on round ${round}`
      break
    }
    for (const f of seen) if (f.status === 'open') f.status = 'fixed'
    lastRoundFixedAll = true
  }

  if (!converged && !parkedReason && lastRoundFixedAll) {
    const confirm = await runCodeReviewRound(cfg, { item, round: cfg.codeRounds, confirmation: true, seen, recordSuffix })
    suggestions.push(...confirm.suggestions)
    if (confirm.converged) {
      converged = true
    } else {
      for (const f of confirm.newConfirmed) seen.push({ ...f, round: cfg.codeRounds, status: 'open' })
      parkedReason = `confirmation pass after round ${cfg.codeRounds} surfaced open findings: ${confirm.newConfirmed.map(f => f.key).join(', ')}`
    }
  }

  if (converged) {
    return { item, outcome: 'done', roundsUsed, summary: state.summary, suggestions }
  }
  const open = seen.filter(f => f.status === 'open').map(f => f.key)
  return {
    item,
    outcome: 'parked',
    roundsUsed,
    parkedReason:
      parkedReason ||
      `code-review budget (${cfg.codeRounds}) exhausted with open findings: ${open.join(', ')}`,
    summary: state.summary,
    suggestions,
  }
}

function coordinatorPrompt(cfg: RunConfig, pass: number, { only, addendumMode, recordSuffix, roundsField }: CoordinatorCtx, processed: readonly ProcessedOutcome[] = []): string {
  const stateScript = cfg.scripts.state
  const worktreeScript = cfg.scripts.worktree
  const header = `You are the wave coordinator (pass ${pass}) of the implement stage of strapped run "${cfg.slug}". You are a mechanical executor: run exactly the commands below via Bash and return the JSON described — the scripts do all the computing, you are a pipe. Contract for every script: the "Harness scripts" section of ${cfg.conventionsFile}.

Run root: ${cfg.dir}
State script: node ${stateScript} <command> ...
Worktree script: ${worktreeScript}
${pass === 1 ? `\nFirst pass only — flip the manifest first: run \`node ${stateScript} manifest-status ${cfg.dir} implementing\` (a same-status flip is an idempotent no-op on resume).\n` : ''}`

  if (addendumMode) {
    const doneIds = processed.filter(o => o.outcome === 'done').map(o => o.id)
    const parkedIds = processed.filter(o => o.outcome !== 'done').map(o => o.id)
    const ledger = processed.length
      ? `Progress ledger — the workflow tracked these across the passes of THIS dispatch and it is the ONLY authoritative progress signal: addendum applied (done): ${JSON.stringify(doneIds)}; parked this dispatch: ${JSON.stringify(parkedIds)}. Never dispatch a ledger node again.`
      : `Progress ledger: empty — this is the first pass of this dispatch, so treat EVERY affected node's addendum as unapplied.`
    return `${header}
This is a FEEDBACK (addendum) pass — the "Feedback loop" section of ${cfg.conventionsFile} is authoritative. The affected set is every deliverable whose file under ${cfg.dir}/deliverables/ contains a \`## Feedback addendum\` section${only ? ` intersected with the single node ${only}` : ''}. No new deliverables, branches, or worktrees are minted.

${ledger} Never infer "addendum applied" from \`feedback_rounds_used\`, from existing ${cfg.dir}/reviews/<id>-code-round-*${recordSuffix}.md records, or from node statuses — all of those can be left over from a PRIOR feedback batch, and the feedback lifecycle is status-neutral (a node returns to its pre-addendum status after its fix lands).

1. Run \`node ${stateScript} dag ${cfg.dir}\` for the nodes, their frontmatter, and the authoritative \`topo\` order — never hand-roll them.
2. Run \`node ${stateScript} resolve ${cfg.slug}\` for the repos map (per repo: root, validations, worktreeRoot, provisioning).
3. This pass's wave is the next topological RANK of the affected set counting ONLY nodes not in the progress ledger (parents before children — a parent's fixes must land before its children's wave). A ledger node (done or parked) is never dispatched again; a node whose current status is \`parked\` is not dispatched either.
4. Per node in the wave:
   - Node with an open PR (\`pr:\` frontmatter non-null — status \`pr-open\`, or \`fixing\` on resume): \`node ${stateScript} transition <deliverableFile> fixing\` (idempotent when already \`fixing\`).
   - Pre-PR node at \`done\` whose \`pr:\` frontmatter is null (e.g. the pr stage report-and-skipped it): dispatch it WITHOUT any transition — there is no \`done>fixing\` edge, so \`transition fixing\` would fail; its addendum applies on the existing branch and the node stays \`done\`.
   - Reuse the EXISTING worktree/branch from its frontmatter; verify with \`${worktreeScript} <repoRoot> <worktree> <branch> <base>\` (idempotent reuse; non-zero exit is a hard stop — report, don't improvise). Never create anything new.
   - resumeNote: null unless the node was mid-fix; then compose a short string from its frontmatter (\`parked_reason\`, \`${roundsField}\`) and the latest ${cfg.dir}/reviews/<id>-code-round-*${recordSuffix}.md — open findings and what was already done.
Return \`items\` (one per wave node: id, repo, repoRoot, validations, planFile as the ABSOLUTE deliverable file path, worktree, branch, base, resumeNote, pr — the node's \`pr:\` frontmatter URL, null for a pre-PR node), \`dag\` = an object with EXACTLY three keys — \`ready\`, \`remaining\`, \`blocked\` — copied unchanged from step 1's dag output, NO other dag fields (recorded for auditing; the ledger-derived values below stay authoritative on feedback passes), \`remaining\` = the count of affected nodes NOT in the progress ledger's done list (undispatched and parked-this-dispatch nodes both count), and \`blocked\` = affected nodes waiting on a parked/unfinished parent as [{id, blockedOn}]. When remaining is 0, return items: [].`
  }

  return `${header}
1. Run \`node ${stateScript} dag ${cfg.dir}${only ? ` --only ${only}` : ''}\` — its \`ready\`, \`topo\`, \`blocked\`, and \`remaining\` fields are authoritative; consume them verbatim, never recompute readiness or remaining yourself.
2. Run \`node ${stateScript} resolve ${cfg.slug}\` for the repos map (per repo: root, validations, worktreeRoot, provisioning).
3. For EACH node in \`ready\` (this pass's wave):
   - Look up its repo's { root, validations, worktreeRoot, provisioning } via the node's \`repo\` field.
   - Worktree path: <worktreeRoot>/${cfg.slug}/<id>; branch and base come from the node's frontmatter.
   - Run \`${worktreeScript} <repoRoot> <worktreePath> <branch> <base>\` (idempotent: reuses a matching worktree, re-attaches an existing branch, otherwise creates from base; a non-zero exit is a hard stop — report it, don't improvise). Apply the repo's \`provisioning\` instructions only to a FRESH worktree (\`created: true\`), placeholder values only, never real secrets.
   - Record: \`node ${stateScript} set <deliverableFile> worktree <worktreePath>\` then \`node ${stateScript} transition <deliverableFile> in-progress\` (a \`parked\` node readmitted via --only flips parked → in-progress; in-progress → in-progress is an idempotent no-op).
   - resumeNote: null for a fresh (\`pending\`) node. For a re-dispatched node (was \`in-progress\` or \`parked\`), compose a short string from its frontmatter (\`parked_reason\`, \`${roundsField}\`) and the latest ${cfg.dir}/reviews/<id>-code-round-*${recordSuffix}.md record — open findings and what was already done.
Return \`items\` (one per ready node: id, repo, repoRoot, validations, planFile as the ABSOLUTE deliverable file path, worktree, branch, base, resumeNote, pr — the node's \`pr:\` frontmatter URL, null when none), \`dag\` = an object with EXACTLY three keys — \`ready\`, \`remaining\`, \`blocked\` — each value copied unchanged from the dag command's printed JSON; include NO other dag fields (nodes, topo, manifest are rejected by the schema). The workflow validates your wave against this paste — a wave that omits a ready node is rejected. Also return top-level \`remaining\` and \`blocked\` mirroring those same dag values. When the dag's \`remaining\` is 0, return items: [].`
}

function applyPrompt(cfg: RunConfig, pass: number, results: readonly NodeOutcome[], { addendumMode, roundsField }: { addendumMode: boolean; roundsField: RoundsField }): string {
  const stateScript = cfg.scripts.state
  const outcomes = results.map(r => ({
    id: r.item.id,
    deliverableFile: r.item.planFile,
    outcome: r.outcome,
    roundsUsed: r.roundsUsed,
    parkedReason: r.parkedReason || null,
    pr: r.item.pr || null,
  }))
  return `You are the outcome applier (pass ${pass}) of the implement stage of strapped run "${cfg.slug}". You are a mechanical executor: apply each outcome below to its deliverable's frontmatter by running exactly the state-script commands described (contract: the "Harness scripts" section of ${cfg.conventionsFile}) and return the JSON described. Never hand-edit frontmatter.

State script: node ${stateScript} <command> ...

Wave outcomes:
${JSON.stringify(outcomes, null, 2)}

Per outcome:${addendumMode ? `
- outcome "done" (feedback fix converged) with a non-null \`pr\` in its outcome above: \`node ${stateScript} transition <deliverableFile> in-review\` then return the node to its PR state — \`node ${stateScript} transition <deliverableFile> pr-open\`.
- outcome "done" with \`pr: null\` (pre-PR node — it was dispatched at \`done\` and never entered \`fixing\`): \`node ${stateScript} transition <deliverableFile> done\` (an idempotent no-op). Report the final status per node.
- outcome "parked": \`node ${stateScript} transition <deliverableFile> parked\` then \`node ${stateScript} set <deliverableFile> parked_reason "<parkedReason>"\`.
- always: \`node ${stateScript} set <deliverableFile> ${roundsField} <roundsUsed>\` — the feedback counter, NEVER review_rounds_used.` : `
- outcome "done": \`node ${stateScript} transition <deliverableFile> done\`.
- outcome "parked": \`node ${stateScript} transition <deliverableFile> parked\` then \`node ${stateScript} set <deliverableFile> parked_reason "<parkedReason>"\`.
- always: \`node ${stateScript} set <deliverableFile> ${roundsField} <roundsUsed>\`.`}

Return applied: one entry per outcome { id, status } with the final on-disk status. Do not run anything else.`
}

export async function implementStage(cfg: RunConfig): Promise<ImplementStageResult> {
  const a = stageArgsFor(cfg, 'implement')
  const addendumMode = Boolean(a.addendumMode)
  const recordSuffix = a.recordSuffix || ''
  const roundsField: RoundsField = addendumMode ? 'feedback_rounds_used' : 'review_rounds_used'
  const coordinatorCtx: CoordinatorCtx = { only: a.only || null, addendumMode, recordSuffix, roundsField }

  const outcomes: ProcessedOutcome[] = []
  let blocked: BlockedNode[] = []
  let allDone = false
  let pass = 0
  let maxPasses = Infinity

  while (pass < maxPasses) {
    pass++
    let wave = await agent<WaveResult>(coordinatorPrompt(cfg, pass, coordinatorCtx, outcomes), {
      label: `coordinate:${pass}`,
      phase: 'Implement',
      schema: WAVE_SCHEMA,
    })
    if (!wave) throw new Error(`implement stage: coordinator agent failed on pass ${pass}`)

    // Trust the pasted dag, not the agent's summary; mismatch → one retry, then hard stop.
    if (!addendumMode) {
      const matchesDag = (w: WaveResult) => {
        const itemIds = [...new Set(w.items.map(i => i.id))].sort()
        const readyIds = [...new Set(w.dag.ready)].sort()
        return itemIds.length === readyIds.length && itemIds.every((id, i) => id === readyIds[i])
      }
      if (!matchesDag(wave)) {
        log(`pass ${pass}: coordinator wave [${wave.items.map(i => i.id).join(', ')}] does not match dag ready [${wave.dag.ready.join(', ')}] — re-dispatching once`)
        const mismatchNote = `\n\nRETRY — your previous wave was REJECTED: its items [${wave.items.map(i => i.id).join(', ')}] did not match its own dag paste's ready [${wave.dag.ready.join(', ')}]. Return EXACTLY one items entry per node in the dag command's ready list — no omissions, no extras.`
        wave = await agent<WaveResult>(coordinatorPrompt(cfg, pass, coordinatorCtx, outcomes) + mismatchNote, {
          label: `coordinate:${pass}:retry`,
          phase: 'Implement',
          schema: WAVE_SCHEMA,
        })
        if (!wave) throw new Error(`implement stage: coordinator agent failed on pass ${pass} retry`)
        if (!matchesDag(wave)) {
          throw new Error(
            `implement stage: coordinator wave [${wave.items.map(i => i.id).join(', ')}] does not match its own dag ready [${wave.dag.ready.join(', ')}] after a retry on pass ${pass}`
          )
        }
      }
    }
    const remaining = addendumMode ? wave.remaining : wave.dag.remaining
    if (pass === 1) maxPasses = remaining + 1
    blocked = addendumMode ? wave.blocked : wave.dag.blocked

    if (remaining === 0) {
      allDone = true
      break
    }
    if (!wave.items.length) {
      // Nothing dispatchable but work remains (parked nodes / blocked children):
      // park, don't spin.
      log(`pass ${pass}: no dispatchable node with ${remaining} remaining — stopping`)
      break
    }

    log(`pass ${pass} wave: ${wave.items.map(i => i.id).join(', ')}`)
    const results = await pipeline(
      wave.items,
      item => implementOne(cfg, item, addendumMode),
      state => reviewFixLoop(cfg, state, recordSuffix)
    )
    const waveResults = results.filter(Boolean)

    const applied = await agent<ApplyResult>(applyPrompt(cfg, pass, waveResults, coordinatorCtx), {
      label: `apply:${pass}`,
      phase: 'Implement',
      effort: 'low',
      schema: APPLY_SCHEMA,
    })
    if (!applied) throw new Error(`implement stage: outcome-applier agent failed on pass ${pass}`)

    outcomes.push(
      ...waveResults.map(r => ({
        id: r.item.id,
        outcome: r.outcome,
        roundsUsed: r.roundsUsed,
        parkedReason: r.parkedReason || null,
        summary: r.summary || null,
        suggestions: (r.suggestions || []).map(s => ({ key: s.key, what: s.what, location: s.location })),
      }))
    )

    if (!waveResults.some(r => r.outcome === 'done')) {
      // Zero newly-done progress terminates the loop (park-don't-spin).
      log(`pass ${pass}: zero newly-done progress — stopping`)
      break
    }
  }

  return { outcomes, allDone, blocked }
}
