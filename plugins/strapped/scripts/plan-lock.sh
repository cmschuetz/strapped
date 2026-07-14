#!/usr/bin/env bash
# Strapped plan-gate lock — makes the /strapped:feedback-lite plan gate UNBYPASSABLE.
#
# EnterPlanMode is a model-invoked tool, so "enter plan mode first" in the skill is
# only a guideline the model can skip. These hooks turn it into harness-enforced state:
# the moment /strapped:feedback-lite is invoked, this session is locked and every edit
# tool is denied by the PreToolUse hook until the skill clears the lock (which it does
# only AFTER the user approves the plan via ExitPlanMode). Fail-closed: a stray lock
# blocks edits (safe, recoverable) rather than ever allowing an unapproved edit.
#
# Subcommands (wired in hooks/hooks.json):
#   set          — UserPromptExpansion hook. Locks THIS session iff the invoked command
#                  is feedback-lite. Reads the hook JSON on stdin.
#   guard        — PreToolUse hook (Write|Edit|MultiEdit|NotebookEdit). Emits a deny
#                  decision while this session holds a lock. Reads the hook JSON on stdin.
#   clear <slug> — remove this session's lock for <slug>. Called by the skill post-approval.
#
# The lock is keyed by session_id (present in every hook's stdin) so it never bleeds into
# a different Claude session. The slug is stored as the lock file's contents so `clear <slug>`
# — run in the same session, but without knowing its own session_id — can find and remove it.

LOCKDIR="${HOME}/.claude/.strapped-plan-locks"

# Extract a flat string field from the hook's stdin JSON without a jq dependency.
json_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n1; }

cmd="${1:-}"
case "$cmd" in
  set)
    IN="$(cat)"
    name="$(printf '%s' "$IN" | json_field command_name)"
    case "$name" in
      *feedback-lite*)
        sid="$(printf '%s' "$IN" | json_field session_id)"
        [ -n "$sid" ] || exit 0
        args="$(printf '%s' "$IN" | json_field command_args)"
        slug="$(printf '%s' "$args" | awk '{print $1}')"
        mkdir -p "$LOCKDIR" 2>/dev/null || exit 0
        printf '%s' "$slug" > "$LOCKDIR/$sid" 2>/dev/null || true
        ;;
    esac
    ;;
  guard)
    IN="$(cat)"
    sid="$(printf '%s' "$IN" | json_field session_id)"
    if [ -n "$sid" ] && [ -f "$LOCKDIR/$sid" ]; then
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"strapped feedback-lite: the plan gate is active — no code edits until you approve the plan via ExitPlanMode. This is enforced by the plugin, not a suggestion; do not attempt to work around it."}}'
    fi
    ;;
  clear)
    slug="${2:-}"
    [ -d "$LOCKDIR" ] || exit 0
    for f in "$LOCKDIR"/*; do
      [ -f "$f" ] || continue
      if [ "$(cat "$f" 2>/dev/null)" = "$slug" ]; then rm -f "$f" 2>/dev/null || true; fi
    done
    ;;
  *)
    echo "usage: plan-lock.sh {set|guard|clear <slug>}" >&2
    exit 2
    ;;
esac
exit 0
