#!/usr/bin/env bash
set -u

# SessionStart hook (startup/clear/compact — never resume): inject the strapped
# operating context into Claude's context via stdout — the slim context.md
# operating model (deep formats stay in conventions.md, read on demand) plus a
# live summary of every run under <stateRoot>/runs/. Never breaks session start:
# exit 0 on every path, degraded output over errors.

script_dir="$(cd "$(dirname "$0")" && pwd)"
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$script_dir/.." && pwd)}"
context="$plugin_root/context.md"
[ -f "$context" ] || exit 0

echo "=== STRAPPED PREAMBLE (strapped-preamble-v1) ==="
echo "Operating context for the strapped plugin, auto-injected at session start. Skills assume this is present."
echo ""
cat "$context"
echo ""
echo "=== STRAPPED STATE SUMMARY ==="

. "$script_dir/lib/state-root.sh"
state_root=$(resolve_state_root)

found_runs=0
if [ -n "$state_root" ] && [ -d "$state_root/runs" ]; then
  for manifest in "$state_root/runs"/*/manifest.md; do
    [ -f "$manifest" ] || continue
    run_dir=$(dirname "$manifest")
    slug=$(basename "$run_dir")
    status=$(grep -m1 '^status:' "$manifest" 2>/dev/null | sed 's/^status:[[:space:]]*//')
    [ -n "$status" ] || status="unknown"
    # Per-status deliverable counts, e.g. "1 done, 1 pending, 1 pr-open".
    counts=""
    while IFS= read -r count_line; do
      [ -n "$count_line" ] || continue
      counts="${counts:+$counts, }$count_line"
    done <<EOF
$(grep -h -E '^status: [a-z-]+$' "$run_dir/deliverables"/*.md 2>/dev/null | sed 's/^status:[[:space:]]*//' | sort | uniq -c | sed 's/^[[:space:]]*//')
EOF
    if [ -n "$counts" ]; then
      echo "- $slug [$status]: $counts"
    else
      echo "- $slug [$status]"
    fi
    found_runs=1
  done
fi
[ "$found_runs" = 1 ] || echo "No strapped runs found."

echo "=== END STRAPPED PREAMBLE ==="
exit 0
