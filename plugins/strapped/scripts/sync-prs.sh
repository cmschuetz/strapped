#!/usr/bin/env bash
set -u

command -v gh >/dev/null 2>&1 || exit 0

script_dir=$(cd "$(dirname "$0")" && pwd)
# Mirror preamble.sh: the plugin root is the scripts dir's parent unless the
# harness injected $CLAUDE_PLUGIN_ROOT. state.mjs lives at <plugin_root>/scripts.
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$script_dir/.." && pwd)}"
. "$script_dir/lib/state-root.sh"

# stateRoot must resolve to an absolute path; invalid input — this hook exits silently.
state_root=$(resolve_state_root)
[ -n "$state_root" ] || exit 0
runs_root="$state_root/runs"
[ -d "$runs_root" ] || exit 0

# Track EVERY non-merged deliverable that carries a PR URL — not just pr-open —
# so an externally-merged done/pr-open node is still detected and a
# fixing/in-review/parked PR-bearing node still gets its CLOSED/CHANGES warnings.
files=$(grep -lE "^pr: ['\"]?http" "$runs_root"/*/deliverables/*.md 2>/dev/null) || exit 0
[ -n "$files" ] || exit 0

gh auth status >/dev/null 2>&1 || exit 0

flipped_any=0
flipped_ids=()
for f in $files; do
  status=$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//')
  # A merged node is fully settled; nothing to refresh.
  [ "$status" = merged ] && continue
  # state.mjs writes frontmatter via js-yaml, which leaves a pr: URL unquoted
  # (its :// is colon-slash, a valid plain scalar) and only quotes colon-SPACE
  # values like parked_reason. Tolerate an optional surrounding quote anyway so
  # this stays robust to either shape.
  url=$(grep -m1 -E "^pr: ['\"]?http" "$f" | sed -e 's/^pr:[[:space:]]*//' -e "s/^['\"]//" -e "s/['\"]\$//")
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
      # The ONLY legal `→ merged` edge is pr-open → merged. A MERGED PR reported
      # on a fixing/in-review/parked node (a feedback re-entry or rebase-park
      # node whose pr: URL survives) is left ENTIRELY untouched — flipping it
      # would be an illegal edge and removing its worktree could destroy work the
      # feedback loop is still editing. The sub-cycle returns it to pr-open and a
      # later sync flips it legally.
      if [ "$status" = pr-open ]; then
        sed -i 's/^status: pr-open$/status: merged/' "$f"
        echo "strapped: $slug/$id PR merged → status merged ($url)"
        flipped_any=1
        flipped_ids+=("$slug/$id")
        # sync-prs flips status with sed, bypassing cmdTransition, so the
        # transition-path worktree cleanup does NOT fire here — call it
        # explicitly. Best-effort; the branch is deliberately kept for --update.
        if command -v node >/dev/null 2>&1; then
          node "$plugin_root/scripts/state.mjs" cleanup "$f" >/dev/null 2>&1 || true
          echo "strapped: $slug/$id worktree cleaned up"
        fi
      fi
      ;;
    CLOSED)
      echo "strapped: $slug/$id PR was closed WITHOUT merging — needs attention ($url)"
      ;;
    *)
      if [ "${decision:-}" = "CHANGES_REQUESTED" ]; then
        echo "strapped: $slug/$id PR has changes requested — needs attention ($url)"
        echo "strapped: $slug/$id → address via /strapped:feedback-lite $slug (or /strapped:feedback for a larger re-work)"
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
      fstatus=$(grep -m1 '^status:' "$f" | sed 's/^status:[[:space:]]*//')
      id=$(grep -m1 '^id:' "$f" | sed 's/^id:[[:space:]]*//')
      deps=$(grep -m1 '^deps:' "$f" | sed 's/^deps:[[:space:]]*\[\(.*\)\]/\1/' | tr -d ' ')
      case "$fstatus" in
        pending)
          # Existing unblocked-implement hint: a pending child whose deps are all complete.
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
            echo "strapped: $slug/$id is now unblocked → /strapped:implement $slug --only $id"
          fi
          ;;
        in-progress | done | pr-open | parked)
          # Drift advisory: a non-pending child whose parent flipped merged THIS
          # session has an advanced base — advise the freeze-rule rebase. The hook
          # never auto-rebases (that would break session start).
          [ -n "$deps" ] || continue
          IFS=',' read -ra dep_arr <<<"$deps"
          for dep in "${dep_arr[@]}"; do
            for fl in "${flipped_ids[@]}"; do
              if [ "$fl" = "$slug/$dep" ]; then
                echo "strapped: $slug/$id base advanced → /strapped:pr $slug --update"
                break 2
              fi
            done
          done
          ;;
      esac
    done
  done
fi

# Checkpoint the git-backed state root (bootstraps on first run). Best-effort.
if command -v node >/dev/null 2>&1; then
  node "$plugin_root/scripts/state.mjs" commit >/dev/null 2>&1 || true
fi
exit 0
