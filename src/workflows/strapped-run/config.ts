// Config parsing for the mono-workflow: the ambient `args` value (object or
// JSON string) is narrowed exactly once, here, into a fully-typed RunConfig.
// The stage-list validation errors are contract — their messages are asserted
// verbatim by tests/strapped-run.test.js.

import type {
  ImplementStageArgs,
  PlanStageArgs,
  PrStageArgs,
  RepoRef,
  RulePartition,
  RunConfig,
  RunScripts,
  StageArgsMap,
  StageName,
} from './types.ts'

export const STAGE_ORDER: readonly StageName[] = ['plan', 'implement', 'pr']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(rec: Record<string, unknown>, key: string): string {
  const value = rec[key]
  if (typeof value !== 'string') throw new Error(`config field "${key}" must be a string`)
  return value
}

function requireNumber(rec: Record<string, unknown>, key: string): number {
  const value = rec[key]
  if (typeof value !== 'number') throw new Error(`config field "${key}" must be a number`)
  return value
}

/** BFS research rounds including the planner's own round 1: absent → 2, min 1. */
function parseResearchRounds(value: unknown): number {
  if (value === undefined) return 2
  if (typeof value !== 'number' || value < 1) {
    throw new Error('config field "researchRounds" must be a number >= 1')
  }
  return value
}

// The four stage-validation throws below predate the TS port and are asserted
// verbatim — never reword them.
function parseStages(value: unknown): StageName[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`stages must be a non-empty ordered subset of [${STAGE_ORDER.join(', ')}]`)
  }
  const list: unknown[] = value
  const stages: StageName[] = []
  const seenStages = new Set<StageName>()
  let prevIndex = -1
  for (const name of list) {
    const index = STAGE_ORDER.findIndex(s => s === name)
    const stage = index === -1 ? undefined : STAGE_ORDER[index]
    if (stage === undefined) throw new Error(`unknown stage "${name}" — canonical stages: ${STAGE_ORDER.join(', ')}`)
    if (seenStages.has(stage)) throw new Error(`duplicate stage "${stage}"`)
    if (index < prevIndex) throw new Error(`stages out of canonical order at "${stage}" — canonical order: ${STAGE_ORDER.join(', ')}`)
    seenStages.add(stage)
    prevIndex = index
    stages.push(stage)
  }
  return stages
}

function parseScripts(value: unknown): RunScripts {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('config field "scripts" must be an object')
  const scripts: RunScripts = {}
  if (typeof value.state === 'string') scripts.state = value.state
  if (typeof value.worktree === 'string') scripts.worktree = value.worktree
  return scripts
}

function parseRules(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`config: ${where} must be an array of rule ids`)
  const list: unknown[] = value
  return list.map((rule, i) => {
    if (typeof rule !== 'string' || rule.length === 0) {
      throw new Error(`config: ${where}[${i}] must be a rule id string (rule text lives in rulesFile, never in args)`)
    }
    return rule
  })
}

function parseRulesByRound(value: unknown): RulePartition[] {
  if (!Array.isArray(value)) throw new Error('config field "rulesByRound" must be an array')
  const list: unknown[] = value
  return list.map((entry, i) => {
    if (!isRecord(entry)) throw new Error(`config: rulesByRound[${i}] must be a { a, b } rule partition`)
    return { a: parseRules(entry.a, `rulesByRound[${i}].a`), b: parseRules(entry.b, `rulesByRound[${i}].b`) }
  })
}

/**
 * `rulesFile` (abs path to reviews/rules-snapshot.md) is required exactly when
 * review rounds could run: any dispatch carrying a non-empty `rulesByRound`
 * intends review rounds, and its reviewer prompts point agents at this file
 * for the verbatim rule text (args carry ids only). Dispatches that run no
 * review rounds (pr-only, 0-round budgets with `rulesByRound: []`) may omit
 * both fields — the lazy absent-→-[] contract is preserved.
 */
function parseRulesFile(value: unknown, rulesByRound: readonly RulePartition[]): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (value !== undefined && value !== null) throw new Error('config field "rulesFile" must be a string')
  if (rulesByRound.length > 0) {
    throw new Error(
      'config field "rulesFile" (absolute path to reviews/rules-snapshot.md) is required when "rulesByRound" is non-empty — review agents read the rule text from it'
    )
  }
  return null
}

function parseRepos(value: unknown, where: string): RepoRef[] {
  if (!Array.isArray(value)) throw new Error(`config: ${where} must be an array of repos`)
  const list: unknown[] = value
  return list.map((repo, i) => {
    if (!isRecord(repo) || typeof repo.name !== 'string' || typeof repo.root !== 'string') {
      throw new Error(`config: ${where}[${i}] must be a repo { name, root }`)
    }
    return { name: repo.name, root: repo.root }
  })
}

function parsePlanArgs(value: unknown): PlanStageArgs {
  if (!isRecord(value)) throw new Error('config: stageArgs.plan must be an object')
  const parsed: PlanStageArgs = {}
  if (value.sourcePlan !== undefined) {
    if (typeof value.sourcePlan !== 'string') throw new Error('config: stageArgs.plan.sourcePlan must be a string')
    parsed.sourcePlan = value.sourcePlan
  }
  if (value.repos !== undefined) parsed.repos = parseRepos(value.repos, 'stageArgs.plan.repos')
  return parsed
}

function parseImplementArgs(value: unknown): ImplementStageArgs {
  if (!isRecord(value)) throw new Error('config: stageArgs.implement must be an object')
  const parsed: ImplementStageArgs = {}
  if (value.only !== undefined && value.only !== null) {
    if (typeof value.only !== 'string') throw new Error('config: stageArgs.implement.only must be a string')
    parsed.only = value.only
  }
  return parsed
}

function parsePrArgs(value: unknown): PrStageArgs {
  if (!isRecord(value)) throw new Error('config: stageArgs.pr must be an object')
  const parsed: PrStageArgs = {}
  if (value.dryRun !== undefined) {
    if (typeof value.dryRun !== 'boolean') throw new Error('config: stageArgs.pr.dryRun must be a boolean')
    parsed.dryRun = value.dryRun
  }
  return parsed
}

function parseStageArgsMap(value: unknown): StageArgsMap {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new Error('config field "stageArgs" must be an object')
  const parsed: StageArgsMap = {}
  if (value.plan !== undefined) parsed.plan = parsePlanArgs(value.plan)
  if (value.implement !== undefined) parsed.implement = parseImplementArgs(value.implement)
  if (value.pr !== undefined) parsed.pr = parsePrArgs(value.pr)
  return parsed
}

/** Narrow the ambient `args` (object or JSON string) into the typed RunConfig. */
export function parseConfig(raw: unknown): RunConfig {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!isRecord(parsed)) throw new Error('config must be an object or its JSON string')
  const stages = parseStages(parsed.stages)
  // rulesByRound is read only lazily inside review rounds (rulesForRound),
  // so pr-only / plan-less dispatches (e.g. the /strapped:pr singleton) omit
  // it entirely — treat absent as [] to match the pre-port lazy contract.
  const rulesByRound = parsed.rulesByRound === undefined ? [] : parseRulesByRound(parsed.rulesByRound)
  return {
    slug: requireString(parsed, 'slug'),
    dir: requireString(parsed, 'dir'),
    conventionsFile: requireString(parsed, 'conventionsFile'),
    scripts: parseScripts(parsed.scripts),
    seed: requireNumber(parsed, 'seed'),
    confidenceMin: requireNumber(parsed, 'confidenceMin'),
    planRounds: requireNumber(parsed, 'planRounds'),
    codeRounds: requireNumber(parsed, 'codeRounds'),
    researchRounds: parseResearchRounds(parsed.researchRounds),
    rulesByRound,
    rulesFile: parseRulesFile(parsed.rulesFile, rulesByRound),
    stages,
    stageArgs: parseStageArgsMap(parsed.stageArgs),
  }
}

export function stageArgsFor(cfg: RunConfig, name: 'plan'): PlanStageArgs
export function stageArgsFor(cfg: RunConfig, name: 'implement'): ImplementStageArgs
export function stageArgsFor(cfg: RunConfig, name: 'pr'): PrStageArgs
export function stageArgsFor(cfg: RunConfig, name: StageName): PlanStageArgs | ImplementStageArgs | PrStageArgs {
  return cfg.stageArgs[name] || {}
}

/** The seeded rule partition (id lists) for a 1-indexed review round. */
export function rulesForRound(cfg: RunConfig, round: number): RulePartition {
  const rules = cfg.rulesByRound[round - 1]
  if (!rules) throw new Error(`rulesByRound has no entry for round ${round}`)
  return rules
}

/**
 * The rules-snapshot path for a running review round. `parseConfig` guarantees
 * it whenever `rulesByRound` is non-empty, and review rounds cannot start
 * without a partition — the throw is a belt-and-braces invariant guard.
 */
export function rulesFileFor(cfg: RunConfig): string {
  if (cfg.rulesFile === null) throw new Error('config field "rulesFile" is required to run review rounds')
  return cfg.rulesFile
}

export function repoList(repos: readonly RepoRef[] | undefined): string {
  if (!repos || !repos.length) return '(no target repos supplied)'
  return repos.map(r => `- ${r.name} → ${r.root}`).join('\n')
}
