// Structural sanity beyond `claude plugin validate`: hook commands resolve to
// executables, marketplace plugin sources exist, skills have complete
// frontmatter, and workflow meta.names are unique and match every name
// referenced across skills, conventions, and the workflow sources themselves.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_ROOT = join(REPO_ROOT, 'plugins', 'strapped')

const EXPECTED_WORKFLOW_NAMES = ['strapped-run']

test('hooks.json parses and every hook command resolves to an existing executable under the plugin root', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'))
  const commands = Object.values(hooks.hooks)
    .flat()
    .flatMap(matcher => matcher.hooks)
    .filter(h => h.type === 'command')
    .map(h => h.command)
  assert.ok(commands.length > 0, 'expected at least one command hook')
  for (const command of commands) {
    const resolved = command.replaceAll('${CLAUDE_PLUGIN_ROOT}', PLUGIN_ROOT)
    assert.ok(resolved.startsWith(PLUGIN_ROOT), `hook command escapes the plugin root: ${command}`)
    const stat = statSync(resolved) // throws if missing
    assert.ok(stat.isFile(), `hook command is not a file: ${resolved}`)
    assert.ok(stat.mode & 0o111, `hook command is not executable: ${resolved}`)
  }
})

test('marketplace.json plugin source dirs exist and hold a plugin manifest', () => {
  const marketplace = JSON.parse(readFileSync(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
  assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0)
  for (const plugin of marketplace.plugins) {
    const sourceDir = join(REPO_ROOT, plugin.source)
    assert.ok(statSync(sourceDir).isDirectory(), `plugin source missing: ${plugin.source}`)
    const manifest = JSON.parse(readFileSync(join(sourceDir, '.claude-plugin', 'plugin.json'), 'utf8'))
    assert.equal(manifest.name, plugin.name)
  }
})

test('every skills/*/SKILL.md has frontmatter with name and description', () => {
  const skillsDir = join(PLUGIN_ROOT, 'skills')
  const skillDirs = readdirSync(skillsDir).filter(d => statSync(join(skillsDir, d)).isDirectory())
  assert.ok(skillDirs.length > 0, 'expected at least one skill')
  for (const dir of skillDirs) {
    const src = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8')
    const frontmatter = src.match(/^---\n([\s\S]*?)\n---/)
    assert.ok(frontmatter, `${dir}/SKILL.md has no frontmatter`)
    assert.match(frontmatter[1], /^name:\s*\S+/m, `${dir}/SKILL.md frontmatter lacks name`)
    assert.match(frontmatter[1], /^description:\s*\S+/m, `${dir}/SKILL.md frontmatter lacks description`)
  }
})

// GitHub-style heading slugs for the anchor-link check, with fenced code
// blocks stripped so code comments never register as headings.
function conventionHeadings() {
  const src = readFileSync(join(PLUGIN_ROOT, 'conventions.md'), 'utf8')
  const prose = src.replace(/^```[\s\S]*?^```\s*$/gm, '')
  return [...prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map(m => m[1])
}

const slugify = heading =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replace(/ /g, '-')

test('every anchor link in conventions.md and every SKILL.md link into conventions.md resolves to a heading', () => {
  const slugs = new Set(conventionHeadings().map(slugify))
  assert.ok(slugs.size > 0, 'expected headings in conventions.md')

  const conventionsSrc = readFileSync(join(PLUGIN_ROOT, 'conventions.md'), 'utf8')
  const anchors = [...conventionsSrc.matchAll(/\]\(#([^)]+)\)/g)].map(m => m[1])
  assert.ok(anchors.length > 0, 'expected at least one anchor link in conventions.md')
  for (const anchor of anchors) {
    assert.ok(slugs.has(anchor), `conventions.md links to missing heading #${anchor}`)
  }

  const skillsDir = join(PLUGIN_ROOT, 'skills')
  for (const dir of readdirSync(skillsDir)) {
    const src = readFileSync(join(skillsDir, dir, 'SKILL.md'), 'utf8')
    for (const [, fragment] of src.matchAll(/\]\([^)#]*conventions\.md#([^)]+)\)/g)) {
      assert.ok(slugs.has(fragment), `${dir}/SKILL.md links to missing conventions.md heading #${fragment}`)
    }
  }
})

// The SKILL.mds cite conventions sections almost exclusively by prose NAME,
// not markdown link — this fixed list is that prose-citation surface. Add to
// it whenever a skill starts citing a new conventions section by name.
// Case-insensitive PREFIX match: a heading may carry a trailing qualifier
// without breaking the citation.
const PROSE_CITED_SECTIONS = [
  'Config resolution',
  'Cwd-independent slug → run-root resolution',
  'Resolving the per-repo config',
  'Feedback loop',
  'Rule extraction',
  'Seeded rule split',
  'Cross-repo base rule',
  'Cleanup recipe',
]

test('every conventions section cited by name in SKILL.md prose still exists as a heading', () => {
  const headings = conventionHeadings().map(h => h.toLowerCase())
  for (const name of PROSE_CITED_SECTIONS) {
    const wanted = name.toLowerCase()
    assert.ok(
      headings.some(h => h.startsWith(wanted)),
      `conventions.md lost the prose-cited section heading "${name}"`
    )
  }
})

test('workflow meta.names are unique and every referenced workflow name resolves', () => {
  const workflowsDir = join(PLUGIN_ROOT, 'workflows')
  const files = readdirSync(workflowsDir).filter(f => f.endsWith('.js'))
  const names = files.map(f => {
    const src = readFileSync(join(workflowsDir, f), 'utf8')
    const meta = src.match(/^export const meta = \{[\s\S]*?name:\s*'([^']+)'/m)
    assert.ok(meta, `${f} has no meta.name`)
    return meta[1]
  })
  assert.equal(new Set(names).size, names.length, `duplicate workflow meta.names: ${names}`)
  assert.deepEqual([...names].sort(), EXPECTED_WORKFLOW_NAMES)

  // Every workflow-name-shaped reference in skills, conventions, and workflow
  // sources must point at a declared meta.name (no dangling references).
  const referencingFiles = [
    join(PLUGIN_ROOT, 'conventions.md'),
    ...readdirSync(join(PLUGIN_ROOT, 'skills')).map(d => join(PLUGIN_ROOT, 'skills', d, 'SKILL.md')),
    ...files.map(f => join(workflowsDir, f)),
  ]
  const nameSet = new Set(names)
  const referenced = new Set()
  for (const file of referencingFiles) {
    const src = readFileSync(file, 'utf8')
    // Matches the live name (strapped-run) AND any lingering reference to a
    // retired stage-workflow name (strapped-plan-loop, strapped-code-review,
    // ...), so a dangling reference still fails as an unknown name.
    for (const ref of src.match(/strapped-(?:[a-z]+-)?(?:loop|review|wave|synth|run)\b/g) || []) {
      assert.ok(nameSet.has(ref), `${file} references unknown workflow name ${ref}`)
      referenced.add(ref)
    }
  }
  assert.deepEqual([...referenced].sort(), EXPECTED_WORKFLOW_NAMES, 'expected every workflow name to be referenced somewhere')
})
