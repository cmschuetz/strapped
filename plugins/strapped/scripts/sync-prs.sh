#!/usr/bin/env bash
set -u

cd "${CLAUDE_PROJECT_DIR:-$PWD}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
command -v gh >/dev/null 2>&1 || exit 0

read_state_root() { grep -o '"stateRoot"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'; }

# Resolve stateRoot per conventions: env > repo-local config > ~/.claude/strapped.json > default.
repo_config=".claude/strapped-config.json"
anchor="$HOME/.claude/strapped.json"
state_root="${STRAPPED_STATE_ROOT:-}"
[ -n "$state_root" ] || { [ -f "$repo_config" ] && state_root=$(read_state_root "$repo_config"); }
[ -n "$state_root" ] || { [ -f "$anchor" ] && state_root=$(read_state_root "$anchor"); }
[ -n "$state_root" ] || state_root="plans/strapped"

case "$state_root" in "~"|"~/"*) state_root="$HOME${state_root#\~}" ;; esac

# Absolute stateRoot → shared mode (run root <stateRoot>/<repo>). Relative → legacy repo-relative.
case "$state_root" in
  /*)
    repo=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
    [ -n "$repo" ] || exit 0
    run_root="$state_root/$repo"
    ;;
  *) run_root="$state_root" ;;
esac
[ -d "$run_root" ] || exit 0

files=$(grep -l '^status: pr-open$' "$run_root"/*/deliverables/*.md 2>/dev/null) || exit 0
[ -n "$files" ] || exit 0

gh auth status >/dev/null 2>&1 || exit 0

flipped_any=0
for f in $files; do
  url=$(grep -m1 '^pr: http' "$f" | sed 's/^pr:[[:space:]]*//')
  [ -n "$url" ] || continue
  id=$(grep -m1 '^id:' "$f" | sed 's/^id:[[:space:]]*//')
  slug=$(basename "$(dirname "$(dirname "$f")")")
  json=$(timeout 10 gh pr view "$url" --json state,reviewDecision 2>/dev/null) || {
    echo "strapped: $slug/$id — could not check PR state ($url)"
    continue
  }
  state=$(printf '%s' "$json" | grep -o '"state":"[A-Z]*"' | cut -d'"' -f4)
  decision=$(printf '%s' "$json" | grep -o '"reviewDecision":"[A-Z_]*"' | cut -d'"' -f4)
  case "$state" in
    MERGED)
      sed -i 's/^status: pr-open$/status: merged/' "$f"
      echo "strapped: $slug/$id PR merged → status merged ($url)"
      flipped_any=1
      ;;
    CLOSED)
      echo "strapped: $slug/$id PR was closed WITHOUT merging — needs attention ($url)"
      ;;
    *)
      if [ "${decision:-}" = "CHANGES_REQUESTED" ]; then
        echo "strapped: $slug/$id PR has changes requested — needs attention ($url)"
      fi
      ;;
  esac
done

if [ "$flipped_any" = 1 ]; then
  for d in "$run_root"/*/; do
    slug=$(basename "$d")
    for f in "$d"deliverables/*.md; do
      [ -f "$f" ] || continue
      grep -q '^status: pending$' "$f" || continue
      deps=$(grep -m1 '^deps:' "$f" | sed 's/^deps:[[:space:]]*\[\(.*\)\]/\1/' | tr -d ' ')
      [ -n "$deps" ] || continue
      ready=1
      IFS=',' read -ra dep_arr <<<"$deps"
      for dep in "${dep_arr[@]}"; do
        depfile=$(ls "$d"deliverables/"$dep"-*.md 2>/dev/null | head -1)
        if [ -z "$depfile" ]; then
          ready=0
          break
        fi
        depstatus=$(grep -m1 '^status:' "$depfile" | sed 's/^status:[[:space:]]*//')
        case "$depstatus" in
          done | pr-open | merged) ;;
          *)
            ready=0
            break
            ;;
        esac
      done
      if [ "$ready" = 1 ]; then
        id=$(grep -m1 '^id:' "$f" | sed 's/^id:[[:space:]]*//')
        echo "strapped: $slug/$id is now unblocked → /strapped:implement $slug --only $id"
      fi
    done
  done
fi
exit 0
