# Normalized event schema (`PetEvent`, schema v1)

One line of JSONL per event. Deliberately small: a hook writes this at ~5 ms, and the whole
point of normalizing is that nothing downstream ever learns a Claude Code field name.

```jsonc
{
  "v": 1,
  "ts": "2026-10-03T15:40:00.123-04:00",  // ISO 8601 with offset, from `date`
  "type": "TOOL_STARTED",
  "sid": "a1b2c3d4",                      // first 8 chars of the session UUID — correlation only
  "tool": "bash",                         // allow-listed lowercase class, see below
  "agent": "explore",                     // present only for subagent-scoped events
  "n": 1                                  // count/multiplicity, default 1
}
```

Every field except `v`, `ts`, `type` is optional. A parser that cannot read a line **drops
that line and increments a counter** — it never throws and never guesses.

## Event types

| Type | Emitted from | Carries | Meaning for the creature |
|---|---|---|---|
| `SESSION_STARTED` | `SessionStart` | `model` | wake up |
| `PROMPT_SUBMITTED` | `UserPromptSubmit` | — | a turn begins |
| `MODEL_ACTIVE` | first `MessageDisplay` of a turn | — | thinking/generating |
| `OUTPUT_STREAMING` | `MessageDisplay` | `n` | generation rate proxy (**chunks, not tokens**) |
| `FILE_READ` | `PreToolUse` · Read/NotebookRead | `n` | reading |
| `FILE_WRITE` | `PreToolUse` · Write/Edit/NotebookEdit | `n` | coding |
| `SEARCH` | `PreToolUse` · Grep/Glob/WebSearch/WebFetch | `n` | scanning |
| `TOOL_STARTED` | `PreToolUse` · any other tool | `tool` | tool use |
| `TOOL_FINISHED` | `PostToolUse` | `tool`, `ms` | tool use ended |
| `BASH_STARTED` | `PreToolUse` · Bash | — | command execution |
| `BASH_FINISHED` | `PostToolUse` · Bash | `ms` | command ended |
| `SUBAGENT_STARTED` | `SubagentStart` | `agent` | more arms |
| `SUBAGENT_FINISHED` | `SubagentStop` | `agent` | fewer arms |
| `PERMISSION_WAITING` | `PermissionRequest`, `Notification:permission_prompt` | `tool` | waiting on the human |
| `PERMISSION_RESOLVED` | `PreToolUse` after a pending request, or `PermissionDenied` | `tool` | stop waiting |
| `MODEL_IDLE` | `Notification:idle_prompt` | — | idle |
| `COMPACTED` | `PostCompact` | `meter.context_used_pct` if present | context just shrank |
| `TURN_COMPLETED` | `Stop` | — | happy completion |
| `ERROR` | `PostToolUseFailure`, `StopFailure` | `scope`, `code` | confusion/distress |
| `SESSION_ENDED` | `SessionEnd` | `reason` | go to sleep |
| `METER_SAMPLE` | `statusLine` command | `meter{…}` | gauges, not activity |

`METER_SAMPLE` is the only event that is a **gauge** rather than an occurrence. It never
contributes to `load_score`; it feeds `context_load` and the session statistics.

```jsonc
{
  "v": 1, "ts": "…", "type": "METER_SAMPLE", "sid": "a1b2c3d4",
  "meter": {
    "context_used_pct": 34,        // context_window.used_percentage  (nullable)
    "context_window": 200000,      // context_window.context_window_size
    "in_tokens": 68400,            // context_window.total_input_tokens
    "out_tokens": 1200,            // context_window.total_output_tokens
    "cost_usd": 1.2345,            // cost.total_cost_usd
    "api_ms": 23000,               // cost.total_api_duration_ms
    "wall_ms": 450000,             // cost.total_duration_ms
    "lines_added": 156, "lines_removed": 23,
    "rate_5h_pct": 23.5,           // rate_limits.five_hour.used_percentage
    "effort": "high",
    "model": "claude-opus-5"
  }
}
```

## Tool classes (`tool`)

The hook maps Claude Code's `tool_name` onto a small closed set, lowercased. Anything
unrecognised becomes `other` — **never the raw name**, so an MCP tool called
`mcp__acme_internal__get_customer_pii` cannot leak a vendor or customer name into the spool.

```text
bash · read · write · edit · search · fetch · task · todo · notebook · mcp · other
```

`mcp` collapses every `mcp__*` tool. The server name is intentionally discarded: a tool
called `mcp__acme_internal__get_customer_pii` would otherwise put a vendor — or a customer —
into a plaintext file.

## `sid`

The first 8 characters of Claude Code's `session_id`. That value is already an opaque
random UUID carrying nothing about the user, so it is **not** hashed: a `shasum` process
would add ~5 ms to every tool call to obscure a random number. Its only purpose is to
correlate events from the same session when several are running.

## What the schema cannot contain, by construction

There is no field in `PetEvent` capable of holding:

- file paths or file content (`tool_input` is never read);
- prompt text (`prompt` is never read; only `prompt_id` exists upstream and we don't keep it);
- command strings or arguments (`Bash.command` is never read);
- terminal output or tool results (`tool_result`, `error`, `last_assistant_message`, `message_text` are never read);
- `cwd`, repo or branch names (the session UUID prefix is kept — see below).

This is enforced in two places, not one: the hook script extracts an explicit allow-list of
keys with `jq`, and `parsePetEvent()` in `core` drops any unknown key before the event
reaches the engine. See `docs/PRIVACY.md`.

## Versioning

`v` is the schema version. The daemon accepts `v: 1` and drops anything else with a warning
rather than attempting a migration — a spool line is worth milliseconds, not a compatibility
layer.
