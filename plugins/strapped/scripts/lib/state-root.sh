# Shared stateRoot resolution for the SessionStart hook scripts. Sourced, never
# executed. Cwd-independent (no cd, no CLAUDE_PROJECT_DIR); safe under `set -u`.

read_state_root() { grep -o '"stateRoot"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'; }

# Resolve stateRoot per conventions: env > ~/.claude/strapped.json > default
# ~/.claude/strapped, with a leading ~ expanded to $HOME. Echoes the resolved
# absolute path; echoes nothing when the value is invalid (still relative after
# expansion) — the caller decides how to bail.
resolve_state_root() {
  local anchor state_root
  anchor="$HOME/.claude/strapped.json"
  state_root="${STRAPPED_STATE_ROOT:-}"
  [ -n "$state_root" ] || { [ -f "$anchor" ] && state_root=$(read_state_root "$anchor"); }
  [ -n "$state_root" ] || state_root="$HOME/.claude/strapped"

  case "$state_root" in "~" | "~/"*) state_root="$HOME${state_root#\~}" ;; esac

  # stateRoot must be absolute; a relative value is invalid input.
  case "$state_root" in /*) printf '%s\n' "$state_root" ;; esac
  return 0
}
