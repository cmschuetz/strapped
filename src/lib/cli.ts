// Shared CLI plumbing for the strapped harness scripts. Every deployable CLI
// writes exactly one JSON object to stdout on success and one prefixed line to
// stderr + exit 1 on misuse — these two helpers are that whole contract.

/** Write `<prefix>: <msg>` to stderr and exit 1. Never returns. */
export function die(prefix: string, msg: string): never {
  process.stderr.write(`${prefix}: ${msg}\n`)
  process.exit(1)
}

/** Write one JSON object to stdout, newline-terminated. */
export function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
