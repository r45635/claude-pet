#!/bin/sh
# claude-pet — the hot path.
#
# One script for every hook event. Reads the hook payload on stdin, extracts an
# allow-list of metadata with jq, appends ONE normalized JSONL line to the spool.
#
# Hard rules, in order of importance:
#   1. It always exits 0. A broken pet must never block or fail a tool call.
#   2. No node, no network, no lock. Measured: node -e 0 costs ~80 ms, jq ~5 ms, and
#      PreToolUse sits in front of every single tool call.
#   3. It constructs its output object explicitly. There is no code path that copies an
#      input object through, so `prompt`, `tool_input`, `tool_result`, `cwd` and friends
#      cannot reach the spool even if a future Claude Code version adds more of them.
#      See docs/PRIVACY.md.
set -u

PET_HOME="${CLAUDE_PET_HOME:-$HOME/.claude-pet}"
SPOOL_DIR="$PET_HOME/spool"
SPOOL="$SPOOL_DIR/events.jsonl"

command -v jq >/dev/null 2>&1 || exit 0
[ -d "$SPOOL_DIR" ] || mkdir -p "$SPOOL_DIR" 2>/dev/null || exit 0
chmod 700 "$PET_HOME" "$SPOOL_DIR" 2>/dev/null

# A single jq program. `empty` means "this event carries no signal" and writes nothing.
jq -c '
  def iso:
    now as $n
    | ($n | floor) as $s
    | ((("00" + ((($n - $s) * 1000) | floor | tostring)) | .[-3:])) as $ms
    | (($s | todate) | .[0:19]) + "." + $ms + "Z";

  def toolclass:
    (. // "") as $n
    | if   $n == "Bash"                      then "bash"
      elif $n == "Read"                      then "read"
      elif $n == "Write"                     then "write"
      elif $n == "Edit" or $n == "MultiEdit" then "edit"
      elif $n == "Grep" or $n == "Glob"      then "search"
      elif $n == "WebFetch" or $n == "WebSearch" then "fetch"
      elif $n == "Agent" or $n == "Task"     then "task"
      elif $n == "TodoWrite"                 then "todo"
      elif ($n | startswith("Notebook"))     then "notebook"
      elif ($n | startswith("mcp__"))        then "mcp"
      else "other" end;

  # The session UUID is already an opaque random identifier; the first 8 chars are enough
  # to correlate events and carry nothing about the user. No hashing process in the hot path.
  def sid: ((.session_id // "") | .[0:8]);

  . as $h
  | ($h.hook_event_name // "") as $e
  | ($h.tool_name | toolclass) as $t
  | ($h.agent_type // "" | ascii_downcase) as $a
  | (
      if $e == "PreToolUse" then
        { type: (if   $t == "bash"                        then "BASH_STARTED"
                 elif $t == "read" or $t == "notebook"    then "FILE_READ"
                 elif $t == "write" or $t == "edit"       then "FILE_WRITE"
                 elif $t == "search" or $t == "fetch"     then "SEARCH"
                 else "TOOL_STARTED" end), tool: $t }
      elif $e == "PostToolUse" then
        { type: (if $t == "bash" then "BASH_FINISHED" else "TOOL_FINISHED" end), tool: $t }
      elif $e == "PostToolUseFailure" then
        { type: "ERROR", tool: $t, scope: "tool" }
      elif $e == "UserPromptSubmit"  then { type: "PROMPT_SUBMITTED" }
      elif $e == "Stop"              then { type: "TURN_COMPLETED" }
      elif $e == "StopFailure"       then { type: "ERROR", scope: "api",
                                           code: ($h.error_type // "unknown") }
      elif $e == "SubagentStart"     then { type: "SUBAGENT_STARTED", agent: $a }
      elif $e == "SubagentStop"      then { type: "SUBAGENT_FINISHED", agent: $a }
      elif $e == "PermissionRequest" then { type: "PERMISSION_WAITING", tool: $t }
      elif $e == "PermissionDenied"  then { type: "PERMISSION_RESOLVED", tool: $t }
      elif $e == "MessageDisplay"    then { type: "OUTPUT_STREAMING" }
      elif $e == "SessionStart"      then { type: "SESSION_STARTED" }
      elif $e == "SessionEnd"        then { type: "SESSION_ENDED",
                                           reason: ($h.end_reason // "other") }
      elif $e == "PostCompact"       then { type: "COMPACTED" }
      elif $e == "Notification" then
        (if   ($h.notification_type // "") == "permission_prompt" then
            { type: "PERMISSION_WAITING" }
         elif ($h.notification_type // "") == "idle_prompt" then
            { type: "MODEL_IDLE" }
         else null end)
      else null end
    ) as $out
  | if $out == null then empty
    else { v: 1, ts: iso, sid: sid } + ($out | with_entries(select(.value != "" and .value != null)))
    end
' >> "$SPOOL" 2>/dev/null

exit 0
