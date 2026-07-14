// Enforces the source plan's "no `any` or other workarounds to make it compile"
// rule as tooling, wired into the `test` gate (`bun run lint`):
//   - `@typescript-eslint/no-explicit-any` bans explicit `any` (: any, as any, <any>).
//   - `@typescript-eslint/ban-ts-comment` bans @ts-ignore / @ts-expect-error / @ts-nocheck.
//   - the `no-restricted-syntax` rule below bans `x as unknown as T` double-casts by
//     AST shape (a TSAsExpression nested directly in another) — reformatting cannot
//     dodge it and it never false-matches the string inside a comment or literal.
// Implicit `any` is covered by the strict tsconfig's `noImplicitAny`, so it is not
// reimplemented here.
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
  {
    files: ['src/**/*.ts', 'tools/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // Explicitly ban all three suppressions. A bare `'error'` uses the rule's
      // defaults, which leave `@ts-expect-error` allowed-with-description — a hole
      // AC3 (and the README) require closed, so pin every variant to `true`.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSAsExpression',
          message:
            "Double-cast 'x as unknown as T' is a banned type workaround — fix the underlying type.",
        },
      ],
    },
  },
]
