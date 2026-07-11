import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { agentByLabel, callWithLabel, runWorkflow } from './helpers/workflow-harness.js'

const WORKFLOW = fileURLToPath(new URL('../plugins/strapped/workflows/pr-run.js', import.meta.url))

function baseCfg(overrides = {}) {
  return {
    slug: 'test-run',
    dir: '/state/runs/test-run',
    conventionsFile: '/plugin/conventions.md',
    stateScript: '/plugin/scripts/state.mjs',
    dryRun: false,
    ...overrides,
  }
}

const PR_RESULT = {
  prs: [
    { id: 'D1', url: 'https://github.com/o/r/pull/1', skipped: false, reason: null },
    { id: 'D2', url: null, skipped: true, reason: 'branch has no commits beyond base' },
  ],
  summary: 'opened 1 PR, skipped 1',
}

test('pr agent prompt carries stateScript + conventions; result surfaced unchanged', async () => {
  const cfg = baseCfg()
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: cfg,
    agent: agentByLabel({ 'pr-create': PR_RESULT }),
  })
  const call = callWithLabel(calls, 'pr-create')
  assert.ok(call.prompt.includes(cfg.stateScript))
  assert.ok(call.prompt.includes(cfg.conventionsFile))
  assert.ok(call.prompt.includes(`resolve ${cfg.slug}`))
  assert.ok(call.prompt.includes(`dag ${cfg.dir}`))
  assert.deepEqual(result, {
    slug: 'test-run',
    dryRun: false,
    prs: PR_RESULT.prs,
    summary: PR_RESULT.summary,
  })
})

test('pr agent prompt carries the Guardrails: never-push-main/never-merge/never-force and report-and-skip via prs[].skipped/reason', async () => {
  const { calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg(),
    agent: agentByLabel({ 'pr-create': PR_RESULT }),
  })
  const prompt = callWithLabel(calls, 'pr-create').prompt
  assert.ok(prompt.includes('Never push `main`'))
  assert.ok(prompt.includes('never merge PRs'))
  assert.ok(prompt.includes('never `--force`'))
  assert.ok(prompt.includes('--force-with-lease'))
  assert.ok(prompt.includes('unauthenticated'))
  assert.ok(prompt.includes('no commits beyond its base'))
  assert.ok(prompt.includes('skipped: true'))
  assert.ok(prompt.includes('reason'))
  // Not a dry run → no print-only instruction.
  assert.ok(!prompt.includes('DRY RUN'))
})

test('dryRun threads the print-only instruction and dryRun flag into the return', async () => {
  const dryResult = {
    prs: [{ id: 'D1', url: null, skipped: true, reason: 'dry run' }],
    summary: 'would run: git -C /repos/alpha push -u origin strapped/test-run/D1-thing',
  }
  const { result, calls } = await runWorkflow(WORKFLOW, {
    args: baseCfg({ dryRun: true }),
    agent: agentByLabel({ 'pr-create': dryResult }),
  })
  const prompt = callWithLabel(calls, 'pr-create').prompt
  assert.ok(prompt.includes('DRY RUN'))
  assert.ok(prompt.includes('print-only'))
  assert.ok(prompt.includes('execute NOTHING that mutates'))
  assert.deepEqual(result, {
    slug: 'test-run',
    dryRun: true,
    prs: dryResult.prs,
    summary: dryResult.summary,
  })
})

test('null pr agent result → rejects', async () => {
  await assert.rejects(
    runWorkflow(WORKFLOW, { args: baseCfg(), agent: agentByLabel({ 'pr-create': () => null }) }),
    /pr agent failed/
  )
})
