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

## Blend, turn work, and smoothing

The channels are blended with a weighted **power mean** (p = 2) over the live channels —
see `EngineConfig.blendExponent` for why an arithmetic mean lies low. Call that `bursts`.

### The turn `work` gauge — the part hooks cannot see

Between `UserPromptSubmit` and `Stop` the model is working — thinking or writing — even when
no hook fires for a minute. *That a turn is running* is observable; *how hard* the model
thinks is not, so the gauge only ramps with turn duration:

```text
work = turn running && not waiting on a permission && an event within 120 s
         ? 60 · (1 − e^(−turn_elapsed / 15 s))
         : 0
```

Measured before it existed, replaying a real 11.7-minute session: mean load **10**, never
above 40, HIGH_LOAD never reached — the creature dozed through the busiest part of the work,
because the long stretches of model reasoning between tool calls emit nothing.

`work` and `bursts` combine as a **soft OR**, so bursts land on top of a working turn
rather than being averaged against it:

```text
raw = 100 − (100 − work) · (100 − bursts) / 100       # 60 working + 40 bursts = 76
```

### Inertia

Reservoirs decay with `tauMs = 10 s` inside a turn — the gaps between real tool calls are
10–30 s of model work and must not drain the channel — and 2.5× faster (`idleDecayFactor`
0.4) once the turn is over, so the creature calms down promptly when Claude stops.

Then an **asymmetric EMA in time** — startle quickly, calm down slowly — with time
constants rather than per-tick coefficients, so the inertia is the same at the daemon's
100 ms busy tick and its 1 s idle tick:

```text
τ = raw > load ? 1 s (attack) : 6 s (release)
load ← load + (1 − e^(−dt/τ)) · (raw − load)
```

HIGH_LOAD has **hysteresis**: entered at 75, left below 65, so a load hovering at the
threshold does not flicker. On the widget side the animation *speed* moves through three
tiers (also with hysteresis) while the *amplitude* follows load continuously: changing
`animation-duration` mid-animation re-maps the phase and makes the creature jump.

Replay of the same real session with the current defaults (`npm run replay`): mean load in
turns **64**, ≥ 40 for 92 % of the time, HIGH_LOAD 25 %, ~2 visual changes per minute.

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
  // HIGH_LOAD / ERROR only, closed values: {"kind":"storm","driver":"tool"},
  // {"kind":"tool_failed","tool":"bash"}, {"kind":"api_error","code":"rate_limit"}
  "reason": null,
  "state": "CODING",
  "load": 82,
  "load_confidence": 0.85,
  "context_load": 34,
  "estimated_activity_rate": 41,
  "tokens_per_minute": null,
  "tool_calls_per_minute": 6,
  "active_subagents": 2,
  // The session the creature shows: the busiest by load, kept until another is clearly
  // busier. load, rates, subagents, context_load and session all describe this one.
  "focus": "a1b2c3d4",
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
