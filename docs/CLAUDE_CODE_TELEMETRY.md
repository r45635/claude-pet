# Claude Code telemetry — what is actually available

**Phase 0 deliverable.** Investigated 2026-10-03 against Claude Code **v2.1.288** on
macOS 26.6.2 (MacBook Air M1). Every claim below is either quoted from the official docs
or verified on this machine; the verification command is given so the finding can be
re-proven instead of trusted.

---

## Recommendation (read this first)

Use **two documented channels, together**. Neither is sufficient alone.

| Channel | Gives | Latency | Status |
|---|---|---|---|
| **Hooks** (`settings.json` → `hooks`) | discrete activity events: prompt submitted, tool started/finished/failed, subagent start/stop, permission waiting, turn end, API error | instant (synchronous, in the hot path) | documented, supported |
| **`statusLine` command** | metered counters: context-window %, token totals, session cost, durations, lines changed, rate-limit % | ~300 ms debounce after each change, plus optional `refreshInterval` timer | documented, supported |

> Hooks say **what Claude is doing**. The status line says **how loaded the session is**.
> `state` comes from hooks, `context_load` comes from the status line, and `load_score`
> blends both.

**Do not** build on the transcript JSONL or on process inspection: both work (see
[Indirect signals](#2-usable-but-indirect-signals)) and both are undocumented internals.
They stay in this document as a *fallback*, behind a feature flag, never as the default.

**OpenTelemetry is a documented third channel** and the only one exposing true per-request
token counts, but its default 60 s metric export interval makes it wrong for an animation.
Keep it as an opt-in enrichment, not the backbone. See [OTEL](#otel-documented-but-too-slow-to-drive-an-animation).

---

## 1. Reliable documented signals

### 1.1 Hooks — the event backbone

33 hook events exist. These are the ones that carry activity signal for us:

| Hook event | Fires when | Fields we use | Normalized event |
|---|---|---|---|
| `SessionStart` | session begins/resumes | `source`, `model`, `context_tokens` *(resume only)* | `SESSION_STARTED` |
| `UserPromptSubmit` | user submits a prompt | `prompt_id` — **never `prompt`** | `PROMPT_SUBMITTED` |
| `PreToolUse` | before a tool call | `tool_name`, `tool_use_id`, `agent_id` | `TOOL_STARTED` / `BASH_STARTED` / `FILE_READ` / … |
| `PostToolUse` | tool call succeeded | `tool_name`, `tool_use_id` — **never `tool_result`** | `TOOL_FINISHED` / `BASH_FINISHED` |
| `PostToolUseFailure` | tool call failed | `tool_name`, `tool_use_id` — **never `error`** | `ERROR` (tool scope) |
| `PostToolBatch` | a parallel batch resolves | `tool_calls` length only | concurrency hint |
| `PermissionRequest` | a tool needs a decision | `tool_name` | `PERMISSION_WAITING` |
| `PermissionDenied` | auto mode denies a call | `tool_name` | `PERMISSION_DENIED` |
| `SubagentStart` / `SubagentStop` | subagent spawned / finished | `agent_type`, `agent_id` | `SUBAGENT_STARTED` / `_FINISHED` |
| `Stop` | Claude finished responding | — **never `last_assistant_message`** | `SESSION_COMPLETED` (turn end) |
| `StopFailure` | turn ended on an API error | `error_type` (enum: `rate_limit`, `overloaded`, `server_error`, …) | `ERROR` (api scope) |
| `MessageDisplay` | assistant text is being displayed | `message_id` only — **never `message_text`** | `OUTPUT_STREAMING` |
| `Notification` | permission prompt / idle prompt / agent needs input | `notification_type` | `PERMISSION_WAITING` / `MODEL_IDLE` |
| `PreCompact` / `PostCompact` | context compaction | `compaction_reason`, `tokens_before`, `tokens_after` *(optional)* | `COMPACTED` |
| `SessionEnd` | session terminates | `end_reason` | `SESSION_ENDED` |

Common fields on most events: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
and usually `prompt_id`, `permission_mode`, `effort`.

Verified on this machine — two `SessionStart`/`Stop` hooks are already wired for the memory hub:

```bash
jq '.hooks | keys' ~/.claude/settings.json      # => ["SessionStart","Stop"]
```

⚠️ **`MessageDisplay` fires per displayed chunk** and is the closest thing to a
"generation rate" signal available from hooks. It is a *rate* proxy, not a token count.

### 1.2 `statusLine` — the metered sampler

The `statusLine.command` receives a JSON object on stdin. Documented fields we use:

```jsonc
{
  "session_id": "…", "prompt_id": "…", "version": "2.1.288",
  "model":  { "id": "claude-opus-5", "display_name": "Opus" },
  "cost":   { "total_cost_usd": 0.01234, "total_duration_ms": 45000,
              "total_api_duration_ms": 2300,
              "total_lines_added": 156, "total_lines_removed": 23 },
  "context_window": {
      "total_input_tokens": 15500, "total_output_tokens": 1200,
      "context_window_size": 200000,
      "used_percentage": 8, "remaining_percentage": 92,
      "current_usage": { "input_tokens": 8500, "output_tokens": 1200,
                         "cache_creation_input_tokens": 5000,
                         "cache_read_input_tokens": 2000 }
  },
  "exceeds_200k_tokens": false,
  "effort": { "level": "high" },
  "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
                   "seven_day": { "used_percentage": 47, "resets_at": 1738900000 } }
}
```

**This is the supported answer to "is token information available?" — yes, as a sampled
gauge, not as a stream.** `context_window.used_percentage` is exactly the `context_load`
the brief asks for, pre-calculated, documented, and officially stable.

Invocation model (documented):
- re-runs on session events, **debounced at 300 ms**;
- an in-flight script is **cancelled** if a new update arrives → the script must be
  idempotent and fast, and must not be the only writer of anything important;
- `refreshInterval` (seconds, min 1) adds a fixed timer — needed because event-driven
  updates **go quiet while the main session is idle**.

🪤 **The status line is a UI slot, not a telemetry hook.** Our script must still print a
useful line for the user, and emit telemetry as a side effect. A script that prints nothing
silently blanks the status bar. And because Claude Code may cancel it mid-run, the write
must be a single atomic append — never a read-modify-write.

Nullability the parser must handle (documented): `context_window.current_usage` is `null`
before the first API call **and again after `/compact`**; `used_percentage` /
`remaining_percentage` may be `null` early in a session; `prompt_cache` is absent until the
first response; `workspace.repo` is absent outside a git repo.

🪤 **The status line only exists in the terminal CLI.** Observed 2026-10-03 with the hooks
installed: a session in the **VS Code extension** emitted 50 hook events and **zero**
`METER_SAMPLE`, while a terminal session on the same machine emitted samples normally. The
extension has no status bar, so it never runs `statusLine.command`. Consequence: in VS Code
the context/token meter is `null` and `sources.statusline` stays `false` — which is the
honest answer. Getting a gauge there means the opt-in transcript or OTEL sources (§2.1, OTEL).

---

## 2. Usable but indirect signals

Ranked by how much we are willing to depend on them. **All of these are undocumented
internals: behind a flag, never the default, never a hard dependency.**

### 2.1 Transcript JSONL — real per-message token usage ✅ works, ⚠️ unsupported

`transcript_path` is a **documented** hook field. Its file *format* is not documented.
Verified on a real 1 805-line session transcript:

```bash
F=~/.claude/projects/<project-key>/<session-id>.jsonl
jq -c 'select(.type=="assistant") | .message.usage' "$F" | tail -1
```

Each `assistant` line carries a full `usage` object:

```json
{ "input_tokens": 2, "cache_creation_input_tokens": 13564,
  "cache_read_input_tokens": 30122, "output_tokens": 539,
  "output_tokens_details": { "thinking_tokens": 172 },
  "service_tier": "standard", "speed": "standard" }
```

and a single `cost-state` line carries the session roll-up (`totalCostUSD`,
`totalToolDuration`, `totalLinesAdded`, per-model `modelUsage`).

➡️ **This is the only way to get a true `tokens_per_minute`** (diff `output_tokens`
between consecutive `assistant` lines and divide by their `timestamp` delta). It is
genuinely accurate. It is also an internal schema that can change in any release.
Observed schema drift risk is real: this file already contains 13 distinct `type` values
(`atis-latch`, `bridge-session`, `queue-operation`, …) none of which are documented.

**Decision:** implement it as `collector.sources.transcript = false` by default. When off,
`tokens_per_minute` is reported as `null`, **not** estimated into a fake number.

### 2.2 `MessageDisplay` rate as a generation proxy ✅ documented, ⚠️ indirect

Counting `MessageDisplay` events per second gives a *shape* that tracks generation
activity without any token figure. Documented hook, zero schema risk, but the unit is
"display chunks", which is not a token and must never be labelled as one.

### 2.3 `cost.total_cost_usd` / `total_api_duration_ms` deltas ✅ documented, ⚠️ coarse

Differencing successive status-line samples gives a cost rate and an API-busy ratio.
Documented and stable, but sampled at the status line's cadence, so bursts shorter than
a sample interval are invisible.

### 2.4 Process inspection — CPU ❌ rejected, network ✅ adopted (macOS)

**CPU ❌.** Measured 2026-10-03 on the `claude` process itself (children excluded, so an
agent-launched `npm test` does not pollute it): 10–20 ms/s while a tool ran, 0–40 ms/s while
the model streamed text. Indistinguishable — in VS Code mode the process only relays
tokens.

**Network ✅.** The model's output — thinking and text — *is* a byte stream into the
`claude` process, and the only real-time sign of it: no hook fires while the model thinks.
`nettop -P -L 1 -p claude -J bytes_in,bytes_out -x` reads per-process byte counters, no
root, no payload, no host. Measured on a real session: each API call shows ~1.9 MB out
(the context) then a few KB in (the stream); a tool running shows 0/0; at rest, ~0.5 KB of
keepalive every ~30 s.

Cost decides the shape: continuous `nettop -L 0` burns **120–134 % CPU** (unusable); a
one-shot `-L 1` costs ~30 ms CPU but takes ~5 s. So `packages/collector/src/net.ts` runs
one-shots back to back **only while a turn is open** — ~0.9 % CPU for the daemon during a
turn, nothing at rest — and maps a session to its process through `$PPID`, added to hook
events for free and resolved by the daemon with a cached `ps` walk. Resolution is ~5 s;
inertia covers it. Off macOS the sensor disables itself and the engine falls back to its
turn-duration ramp.

---

## 3. Unavailable information

| Wanted | Status | Evidence |
|---|---|---|
| Per-tool-call token counts in a hook payload | **unavailable** | docs: hook payloads do not include input/output token counts, per-tool usage, or session-level cumulative usage |
| Session-level token totals from hooks | **unavailable** — except two cases | only `SessionStart` on *resume* (`context_tokens`, `estimated_cache_write_usd`) and `PostCompact` (`tokens_before`, `tokens_after`, both optional) |
| A streaming token-rate push API | **unavailable** | no documented mechanism; the status line is pull/sampled, OTEL is batched |
| "Claude is thinking" as an explicit event | **unavailable** | inferred only: a turn is active (after `UserPromptSubmit`, before `Stop`) with no tool in flight |
| Model's internal reasoning / plan | **unavailable, and out of scope** | see the design principle in `README.md` |
| Context window % without a status line | **unavailable** | `used_percentage` ships only in the status-line payload |

---

## 4. Information we can legitimately estimate

Everything here is **labelled as estimated in the API payload** (`estimated: true`), never
presented as measured.

| Metric | How | Honest label |
|---|---|---|
| `load_score` 0–100 | weighted decaying reservoirs over hook events | **derived** — it is a visualization index, not a physical quantity |
| `estimated_activity_rate` | events/minute over a rolling window | **measured** (events are real); it is the *mapping to effort* that is estimated |
| `tokens_per_minute` | `null` unless the transcript source is enabled | **measured** when on, **absent** when off — never estimated |
| `context_load` 0–100 | `context_window.used_percentage` | **measured**, but stale between status-line samples |
| tool "weight" (a Bash counts more than a Read) | fixed weight table in `config/` | **convention**, tunable, documented |

🎯 **The rule the brief asks for, stated operationally:** the API response always carries a
`sources` block saying which channels were live and a `confidence` for `load_score`. A pet
animating at full tilt on an absent signal is a bug, not a feature.

---

## OTEL — documented, but too slow to drive an animation

`CLAUDE_CODE_ENABLE_TELEMETRY=1` with an OTLP exporter gives the richest *documented*
numbers: `claude_code.token.usage` (attribute `type` ∈ `input|output|cacheRead|cacheCreation`),
`claude_code.cost.usage`, `claude_code.active_time.total`, plus events
`claude_code.user_prompt`, `claude_code.tool_result`, `claude_code.tool_decision`,
`claude_code.api_request`, `claude_code.api_error`.

Why it is not the backbone:

- `OTEL_METRIC_EXPORT_INTERVAL` defaults to **60000 ms**; logs/events to 5000 ms. Lowering
  the metric interval to ~1 s is documented only as a *debug* setting.
- It requires our collector to speak OTLP (an HTTP receiver for `http/json`, or gRPC) —
  a dependency the brief's "minimal dependencies" rule should not pay for in the MVP.
- It is a session-wide env-var change on the user's machine; a bug in our receiver degrades
  every Claude Code session, not just the pet.

**Decision:** `collector.sources.otel = false`, documented as the Phase 5 path to a real
`tokens_per_minute` without touching internal file formats.

---

## Integration decision summary

```
PreToolUse / PostToolUse / Stop / Subagent* / Notification / StopFailure
        │  sh + jq, ~5 ms, appends 1 JSONL line
        ▼
  spool file  (~/.claude-pet/spool/events.jsonl)
        ▲
        │  sh + jq, appends 1 METER_SAMPLE line
statusLine command (also prints the user's real status line)
        │
        ▼
  collector daemon (node, tails spool) → state engine → SSE on 127.0.0.1
```

**Why `sh` + `jq` in the hot path and not Node:** measured on this machine, `node -e 0`
costs **~80 ms** per invocation, `jq -n 1` costs **< 10 ms**. `PreToolUse` is synchronous —
it sits in front of every single tool call. An 80 ms tax on every tool call to animate a
cartoon is not acceptable; 5 ms is. `jq` is present at `/usr/bin/jq` (1.7.1, Apple-shipped
with macOS 26), so this adds no install step.

```bash
command -v jq && jq --version    # /usr/bin/jq → jq-1.7.1-apple
node --version                   # v25.2.1 (runs .ts directly via type stripping)
```

## Closing check / Contrôle de clôture

Run after any Claude Code upgrade. **Proves the documented fields still ship; it does not
prove the transcript fallback still parses** (that one is unsupported by design).

```bash
# 1. hooks still accept our config
jq -e '.hooks.PreToolUse and .hooks.PostToolUse' ~/.claude/settings.json

# 2. the status line still delivers the metered fields (run a session, then:)
tail -1 ~/.claude-pet/spool/events.jsonl | jq -e '.meter.context_used_pct != null'

# 3. events are actually arriving (not just "the file exists")
wc -l < ~/.claude-pet/spool/events.jsonl   # must grow while a session is working
```

⚠️ An existing spool file and a daemon that answers `200` prove the pipeline is *wired*,
not that it is *fed*. Check the line count grows.
