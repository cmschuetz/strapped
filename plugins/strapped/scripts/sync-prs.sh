#!/usr/bin/env bash
set -u

# SessionStart hook (startup + resume). Reconciles every pr-open deliverable's
# PR state, auto-removes the worktree + local branch of a deliverable whose PR
# just merged, sweeps the pre-existing backlog of already-merged deliverables
# whose worktree was never cleaned up, then safety-net snapshots the stateRoot.
# HARD CONTRACT: every path exits 0 — this hook must never break session start,
# so every external call (gh, git, node <state.mjs>) is guarded and tolerated.

command -v gh >/dev/null 2>&1 || exit 0

script_dir="$(cd "$(dirname "$0")" && pwd)"
. "$script_dir/lib/state-root.sh"
state_mjs="$script_dir/state.mjs"

# stateRoot must resolve to an absolute path; invalid input — this hook exits silently.
state_root=$(resolve_state_root)
[ -n "$state_root" ] || exit 0
runs_root="$state_root/runs"
[ -d "$runs_root" ] || exit 0

gh auth status >/dev/null 2>&1 || exit 0

flipped_any=0    # any state change (flip OR sweep-cleared field) → safety-net snapshot
merged_flip=0    # a pr-open → merged flip happened → recompute newly-unblocked children
touched=""       # newline-separated slugs whose run state changed

# Cleanup helper — shared by the merged-flip path and the backlog sweep. Removes
# the deliverable's worktree + local branch in its own repo, then clears the
# worktree field. NEVER flips status (callers own that) and NEVER --forces a
# dirty worktree. Returns 0 only when the worktree was removed and the field
# cleared; 1 on a silent skip (null worktree/repoRoot) or a dirty-worktree warn.
cleanup_worktree() {
  c_slug="$1"; c_id="$2"; c_worktree="$3"; c_branch="$4"; c_repoRoot="$5"; c_file="$6"
  case "${c_worktree:-}" in '' | null) return 1 ;; esac
  case "${c_repoRoot:-}" in '' | null) return 1 ;; esac
  if git -C "$c_repoRoot" worktree remove "$c_worktree" >/dev/null 2>&1; then
    case "${c_branch:-}" in
      '' | null) ;;
      *) git -C "$c_repoRoot" branch -D "$c_branch" >/dev/null 2>&1 || true ;;
    esac
    if [ -n "${c_file:-}" ] && [ "$c_file" != null ]; then
      node "$state_mjs" set "$c_file" worktree null >/dev/null 2>&1 || true
    fi
    echo "strapped: $c_slug/$c_id worktree removed ($c_worktree)"
    return 0
  fi
  echo "strapped: $c_slug/$c_id worktree not clean — left $c_worktree for manual removal"
  return 1
}

# --- reconcile every pr-open deliverable (joined with its repoRoot) ---
rows=$(node "$state_mjs" sync-rows --all --lines 2>/dev/null) || rows=""
while IFS=$'\t' read -r slug id status repoRoot worktree branch pr file; do
  [ -n "${file:-}" ] || continue
  { [ -n "${pr:-}" ] && [ "$pr" != null ]; } || continue
  json=$(timeout 10 gh pr view "$pr" --json state,reviewDecision 2>/dev/null) || {
    echo "strapped: $slug/$id — could not check PR state ($pr)"
    continue
  }
  state=$(printf '%s' "$json" | grep -o '"state":"[A-Z]*"' | cut -d'"' -f4)
  decision=$(printf '%s' "$json" | grep -o '"reviewDecision":"[A-Z_]*"' | cut -d'"' -f4)
  case "$state" in
    MERGED)
      if node "$state_mjs" transition "$file" merged >/dev/null 2>&1; then
        echo "strapped: $slug/$id PR merged → status merged ($pr)"
        flipped_any=1
        merged_flip=1
        touched="${touched}${slug}"$'\n'
        cleanup_worktree "$slug" "$id" "$worktree" "$branch" "$repoRoot" "$file"
      else
        echo "strapped: $slug/$id — could not flip to merged, left as-is ($pr)"
      fi
      ;;
    CLOSED)
      echo "strapped: $slug/$id PR was closed WITHOUT merging — needs attention ($pr)"
      ;;
    *)
      if [ "${decision:-}" = "CHANGES_REQUESTED" ]; then
        echo "strapped: $slug/$id PR has changes requested — needs attention ($pr)"
        echo "strapped: $slug/$id → address via /strapped:feedback $slug"
      fi
      ;;
  esac
done <<<"$rows"

# --- sweep the pre-existing merged backlog (no gh, no status flip) ---
stale=$(node "$state_mjs" stale-worktrees --all --lines 2>/dev/null) || stale=""
while IFS=$'\t' read -r slug id status repoRoot worktree branch pr file; do
  [ -n "${file:-}" ] || continue
  if cleanup_worktree "$slug" "$id" "$worktree" "$branch" "$repoRoot" "$file"; then
    flipped_any=1
    touched="${touched}${slug}"$'\n'
  fi
done <<<"$stale"

# --- newly-unblocked children (only a real merge opens new work) ---
if [ "$merged_flip" = 1 ]; then
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

# --- safety-net snapshot: commit the flips + cleared worktree fields ---
if [ "$flipped_any" = 1 ]; then
  printf '%s' "$touched" | sort -u | while IFS= read -r s; do
    [ -n "$s" ] || continue
    node "$state_mjs" snapshot "$runs_root/$s" >/dev/null 2>&1 || true
  done
fi

exit 0
