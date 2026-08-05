// The mono-workflow entrypoint: parse the ambient `args` into the typed run
// config, then dispatch the selected stages in canonical order, stopping at
// the first failed gate. The build bundles this module (with everything it
// imports) into the script-shaped deployable
// plugins/strapped/workflows/strapped-run.js and appends the top-level
// `return await main()` the workflow executor contract requires.

import { parseConfig } from './config.ts'
import { implementStage } from './stages/implement.ts'
import { planStage } from './stages/plan.ts'
import { prStage } from './stages/pr.ts'
import type { RunConfig, RunResult, StageCtx, StageName, StageResult } from './types.ts'

const STAGES: Record<StageName, (cfg: RunConfig, ctx: StageCtx) => Promise<StageResult>> = {
  plan: planStage,
  implement: implementStage,
  pr: prStage,
}

function gateFailed(name: StageName, result: StageResult): boolean {
  if (name === 'plan') return 'converged' in result && !result.converged
  if (name === 'implement') return 'allDone' in result && !result.allDone
  if (name === 'pr') return Boolean('gateFailed' in result && result.gateFailed)
  return false
}

export default async function main(): Promise<RunResult> {
  const cfg = parseConfig(args)

  const results: Partial<Record<StageName, StageResult>> = {}
  const completed: StageName[] = []
  let stoppedAt: StageName | null = null

  for (const [i, name] of cfg.stages.entries()) {
    phase(name)
    const ctx: StageCtx = {
      hasLaterStage: i < cfg.stages.length - 1,
      ranImplement: completed.includes('implement'),
    }
    const result = await STAGES[name](cfg, ctx)
    if (!result) throw new Error(`stage "${name}" returned no result`)
    results[name] = result
    if (gateFailed(name, result)) {
      stoppedAt = name
      log(`stage "${name}" gate failed — stopping the dispatch`)
      break
    }
    completed.push(name)
  }

  return { slug: cfg.slug, stages: cfg.stages, completed, stoppedAt, results }
}
