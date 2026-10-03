#!/bin/sh
# claude-pet — the metered sampler.
#
# Configured as `statusLine.command`. Does two things, in this order:
#   1. prints a real status line (if it printed nothing, Claude Code would blank the bar);
#   2. appends one METER_SAMPLE event carrying the documented context/cost gauges.
#
# Claude Code cancels an in-flight status-line script when a new update arrives, so the
# append is a single atomic write and never a read-modify-write: a cancellation can lose
# at most one sample. See docs/RISKS.md.
set -u

PET_HOME="${CLAUDE_PET_HOME:-$HOME/.claude-pet}"
SPOOL_DIR="$PET_HOME/spool"
SPOOL="$SPOOL_DIR/events.jsonl"

input=$(cat)

# ---- 1. the visible status line -------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  printf '%s' "$input" | jq -r '
    (.model.display_name // "?") as $m
    | ((.workspace.current_dir // .cwd // "") | split("/") | last // "~") as $d
    | (.context_window.used_percentage // null) as $c
    | (.cost.total_cost_usd // 0) as $cost
    | "[\($m)] 📁 \($d)"
      + (if $c == null then " · ctx —" else " · ctx \($c | floor)%" end)
      + " · $\($cost * 100 | floor / 100)"
  ' 2>/dev/null || printf 'claude'
else
  printf 'claude'
fi

# ---- 2. the telemetry side effect -----------------------------------------------------
command -v jq >/dev/null 2>&1 || exit 0
[ -d "$SPOOL_DIR" ] || mkdir -p "$SPOOL_DIR" 2>/dev/null || exit 0
chmod 700 "$PET_HOME" "$SPOOL_DIR" 2>/dev/null

printf '%s' "$input" | jq -c '
  def iso:
    now as $n
    | ($n | floor) as $s
    | ((("00" + ((($n - $s) * 1000) | floor | tostring)) | .[-3:])) as $ms
    | (($s | todate) | .[0:19]) + "." + $ms + "Z";

  # Every field is read with `// null`: a missing field must become "unknown", never 0.
  { v: 1, ts: iso, type: "METER_SAMPLE",
    sid: ((.session_id // "") | .[0:8]),
    meter: {
      context_used_pct: (.context_window.used_percentage // null),
      context_window:   (.context_window.context_window_size // null),
      in_tokens:        (.context_window.total_input_tokens // null),
      out_tokens:       (.context_window.total_output_tokens // null),
      cost_usd:         (.cost.total_cost_usd // null),
      api_ms:           (.cost.total_api_duration_ms // null),
      wall_ms:          (.cost.total_duration_ms // null),
      lines_added:      (.cost.total_lines_added // null),
      lines_removed:    (.cost.total_lines_removed // null),
      rate_5h_pct:      (.rate_limits.five_hour.used_percentage // null),
      effort:           (.effort.level // null),
      model:            (.model.id // null)
    }
  }
' >> "$SPOOL" 2>/dev/null

exit 0
