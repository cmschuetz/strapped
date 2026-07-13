#!/usr/bin/env bash
# Idempotent worktree creation per conventions.md "Worktrees and branches":
#   ensure-worktree.sh <repoRoot> <worktreePath> <branch> <base>
# - path exists on <branch>            -> reuse, {"created": false}
# - path exists on another branch      -> error, exit 1
# - branch exists but no worktree      -> re-attach (worktree add, no -b)
# - otherwise                          -> create from <base> (worktree add -b)
# Prints one JSON object on stdout; git failures exit non-zero with git's
# stderr passed through (git's stdout is redirected to stderr to keep the
# JSON contract).
set -u

if [ "$#" -ne 4 ]; then
  echo "usage: ensure-worktree.sh <repoRoot> <worktreePath> <branch> <base>" >&2
  exit 1
fi

repo_root=$1
worktree_path=$2
branch=$3
base=$4

emit() { printf '{"worktree":"%s","branch":"%s","created":%s}\n' "$worktree_path" "$branch" "$1"; }

if [ -e "$worktree_path" ]; then
  if ! current=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null); then
    echo "ensure-worktree: $worktree_path exists but is not a git worktree" >&2
    exit 1
  fi
  if [ "$current" = "$branch" ]; then
    emit false
    exit 0
  fi
  echo "ensure-worktree: $worktree_path is checked out on '$current', expected '$branch'" >&2
  exit 1
fi

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$repo_root" worktree add "$worktree_path" "$branch" 1>&2 || exit $?
else
  git -C "$repo_root" worktree add "$worktree_path" -b "$branch" "$base" 1>&2 || exit $?
fi
emit true
