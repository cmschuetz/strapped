// Absolute path of the `node` runtime for spawning the REAL deployables.
//
// Deploy parity requires the deployables to run under node: under `bun test`,
// process.execPath is the bun binary, so spawning it would silently test the
// wrong runtime. Spawning the literal string 'node' is not enough either —
// version managers' shims (asdf) need the real $HOME to locate installs, and
// these tests deliberately spawn with an isolated HOME. So resolve `node`
// from PATH exactly once here, under the inherited environment, and hand the
// resolved absolute binary path to every isolated spawn.

import { spawnSync } from 'node:child_process'

const res = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
const resolved = res.status === 0 ? res.stdout.trim() : ''
if (!resolved) {
  throw new Error(`tests/helpers/node-bin.ts: could not resolve \`node\` from PATH: ${res.stderr}`)
}

export const NODE = resolved
