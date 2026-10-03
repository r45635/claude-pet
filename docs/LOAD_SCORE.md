# `load_score` — algorithm

> `load_score` is a **visualization index**, not a measurement of anything physical.
> It answers "how frantic should the creature look right now?" and nothing else.
> It is reported with a `confidence` and a list of live `sources`, so a pet thrashing on
> an absent signal is detectable as a bug.

## Shape of the model

Four independent **decaying reservoirs**. Each event pours its weight into one reservoir;
each reservoir leaks exponentially. This gives fast attack (an event lands immediately) and
controlled decay (no flicker when events arrive in bursts).

```text
for each channel c:
    r_c ← r_c · exp(−Δt / τ_c)  +  Σ weight(e)   for events e in this tick
    s_c  = 100 · (1 − exp(−r_c / k_c))            # saturating, 0–100, never clips
```

The saturating map matters: a linear `min(100, r/k)` makes the creature pin at 100 and stay
there through a long build, losing all resolution exactly when the session is most
interesting. `1 − e^(−x)` keeps motion visible at every intensity.

| Channel | τ (half-life-ish) | k | Feeds on |
|---|---|---|---|
| `generation` | 8 s | 14 | `OUTPUT_STREAMING`, `MODEL_ACTIVE` |
| `tool` | 10 s | 6 | `TOOL_STARTED`, `BASH_STARTED`, `TOOL_FINISHED`, `BASH_FINISHED` |
| `file` | 12 s | 5 | `FILE_READ`, `FILE_WRITE`, `SEARCH` |
| `agent` | 20 s | 2 | `SUBAGENT_STARTED/FINISHED` **plus a concurrency gauge** |

`agent` is special: beyond the event impulses it adds `activeSubagents · 1.5` to its
reservoir every tick, because three subagents running quietly is genuinely more load than
one, even when none of them emits an event this second.

## Weights

```text
OUTPUT_STREAMING    1.0        FILE_READ      1.0
MODEL_ACTIVE        2.0        FILE_WRITE     2.0
TOOL_STARTED        2.0        SEARCH         1.5
TOOL_FINISHED       0.5        BASH_STARTED   3.0
SUBAGENT_STARTED    4.0        BASH_FINISHED  1.0
SUBAGENT_FINISHED   1.0        ERROR          3.0
```

`BASH_STARTED` outweighs `FILE_READ` because a command is the visibly consequential act.
These are **conventions**, not physics; they live in `config/default.json` and exist to be
tuned by watching the creature next to a real session.

## Blend and smoothing

```text
raw = 0.35·s_generation + 0.30·s_tool + 0.15·s_file + 0.20·s_agent
```

Then an **asymmetric EMA** — the creature should startle quickly and calm down slowly:

```text
α = raw > load ? 0.45 (attack) : 0.12 (release)
load ← load + α · (raw − load)
```

At a 100 ms tick that is ~0.4 s to visually reach a new high and ~2 s to settle back down.
A symmetric filter either lags the startle or jitters on the way down; this was the whole
reason for splitting the coefficient.

Finally `load_score = round(load)` — integer, because a creature cannot animate 72.4138%
differently from 72.4139% and publishing the decimals would be inventing precision.

## Reweighting when a channel is dead

If a source never fires (e.g. `generation` is empty because `MessageDisplay` isn't wired),
its weight is **redistributed across the live channels** rather than silently counted as
zero. Otherwise a perfectly busy session caps at 65/100 and the bug looks like calm.

```text
live = { c : channel c has seen ≥1 event this session }
raw  = Σ_{c ∈ live} (w_c / Σ_{c ∈ live} w_c) · s_c
confidence = Σ_{c ∈ live} w_c          // 0.0 … 1.0, published in the snapshot
```

## `context_load` — separate, and measured

```text
context_load = meter.context_used_pct          // from the status line, documented
```

Not derived, not smoothed, not blended into `load_score`. It is `null` when no
`METER_SAMPLE` has arrived yet or when Claude Code reported `null` (documented: before the
first API call, and again after `/compact`). The widget must render "unknown" as a distinct
look from "0%" — a fresh creature and a creature we know nothing about are not the same
animal.

Bands, for Phase 5 fatigue behaviour:

| `context_load` | Creature |
|---|---|
| `null` | neutral — no fatigue styling at all |
| 0–40 | small, fresh |
| 40–70 | energetic |
| 70–88 | visibly overloaded |
| ≥ 88 | exhausted / unstable glow |

## `tokens_per_minute` — honest about absence

```text
sources.transcript off  →  tokens_per_minute = null         (the default)
sources.transcript on   →  measured from the transcript's assistant usage deltas
```

There is no third branch. The brief's `estimated_activity_rate` fills the gap instead:

```text
estimated_activity_rate = events in the last 60 s        // measured, real, unit = events/min
```

## Published snapshot

```jsonc
{
  "state": "CODING",
  "load": 82,
  "load_confidence": 0.85,
  "context_load": 34,
  "estimated_activity_rate": 41,
  "tokens_per_minute": null,
  "tool_calls_per_minute": 6,
  "active_subagents": 2,
  "session": { "tokens": 115000, "cost_usd": 1.23, "lines_added": 156, "lines_removed": 23 },
  "sources": { "hooks": true, "statusline": true, "transcript": false, "otel": false },
  "estimated": ["load", "estimated_activity_rate"],
  "last_activity_at": "2026-10-03T15:40:00-04:00",
  "updated_at": "2026-10-03T15:40:01-04:00"
}
```

`estimated` names every field in this payload that is derived rather than observed. It is
part of the contract, not a debug extra: the widget may use it to mark a value, and a future
consumer cannot mistake `load` for a measurement.
