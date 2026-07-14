// The equivalence gate for the build-time schema generation (D3 feedback).
//
// The strapped-run regression oracle (tests/strapped-run.test.js) asserts
// nothing about schema CONTENTS — it never inspects enum/minimum/maximum/
// additionalProperties/properties — so a dropped bound, lost enum, or
// $ref-wrapped shape would pass it silently. This test is the actual proof that
// the schemas derived from types.ts still encode the exact structured-output
// contract the hand-written schemas.ts shipped: it deep-equals every generated
// schema against tests/fixtures/schemas.snapshot.json, a verbatim capture of the
// original hand-written schema objects taken before schemas.ts was deleted.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'
import { SCHEMA_TYPES, generateSchemas } from '../tools/gen-schemas.ts'
import * as generated from '../src/workflows/strapped-run/schemas.generated.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/schemas.snapshot.json', import.meta.url)), 'utf8')
) as Record<string, unknown>

void ROOT

test('every original schema constant is captured in the snapshot', () => {
  assert.deepEqual(
    SCHEMA_TYPES.map(([, constant]) => constant).sort(),
    Object.keys(snapshot).sort()
  )
})

test('schemas generated from types.ts deep-equal the frozen hand-written snapshot', () => {
  const fresh = generateSchemas()
  for (const [, constant] of SCHEMA_TYPES) {
    assert.deepEqual(
      fresh[constant],
      snapshot[constant],
      `${constant}: generated schema drifted from the original hand-written contract`
    )
  }
})

test('the committed schemas.generated.ts exports match the frozen snapshot', () => {
  const exported = generated as Record<string, unknown>
  for (const [, constant] of SCHEMA_TYPES) {
    assert.deepEqual(
      exported[constant],
      snapshot[constant],
      `${constant}: shipped constant in schemas.generated.ts drifted from the original contract`
    )
  }
})
