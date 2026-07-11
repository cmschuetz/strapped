#!/usr/bin/env bash
set -u

command -v gh >/dev/null 2>&1 || exit 0

read_state_root() { grep -o '"stateRoot"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'; }

# Resolve stateRoot per conventions: env > ~/.claude/strapped.json > default ~/.claude/strapped.
anchor="$HOME/.claude/strapped.json"
state_root="${STRAPPED_STATE_ROOT:-}"
[ -n "$state_root" ] || { [ -f "$anchor" ] && state_root=$(read_state_root "$anchor"); }
[ -n "$state_root" ] || state_root="$HOME/.claude/strapped"

case "$state_root" in "~"|"~/"*) state_root="$HOME${state_root#\~}" ;; esac

# stateRoot must be absolute; a relative value is invalid input — this hook exits silently.
case "$state_root" in /*) ;; *) exit 0 ;; esac
runs_root="$state_root/runs"
[ -d "$runs_root" ] || exit 0

files=$(grep -l '^status: pr-open$' "$runs_root"/*/deliverables/*.md 2>/dev/null) || exit 0
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
        echo "strapped: $slug/$id → address via /strapped:feedback $slug"
      fi
      ;;
  esac
done

if [ "$flipped_any" = 1 ]; then
  slug_dirs=("$runs_root"/*/)
  for d in "${slug_dirs[@]}"; do
    [ -d "$d" ] || continue
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
