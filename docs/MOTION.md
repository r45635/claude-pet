# Motion architecture

How the creature moves, why it is built this way, and how an avatar gets its own motion
without touching widget code. Companion to [AVATARS.md](AVATARS.md) (the package format)
and [RISKS.md](RISKS.md) #6 (the idle CPU budget this design must never break).

## Where motion lives today (assessment)

Everything that moves is CSS, keyed on DOM attributes that JavaScript writes when a
snapshot changes:

- **All motion is CSS keyframes/transitions** on `data-state` / `data-visual` selectors.
  There is no `requestAnimationFrame` and no `setInterval` anywhere in the widget. JS
  writes attributes and three custom properties — `--amp` (continuous, from load),
  `--dur` (three speed tiers with hysteresis), `--k` (a family's tempo) — plus one
  `setTimeout` per *walking* subagent.
- **The idle freeze is the load-bearing wall.** An always-visible transparent window that
  animates costs ~8.5 % CPU doing nothing (macOS recomposites the whole window every
  frame); frozen, it costs ~0.2 %. The freeze is `animation-play-state: paused !important`
  on `[data-visual="IDLE"]`, `[data-signal="none"]`, `[data-paused="true"]` and per-family
  `[data-still="true"]`, plus a render path that touches the DOM only when the snapshot
  key changes, plus JS that stops scheduling walks and slows hit-region polling.
- **The state → animation bindings were ~10 hardcoded CSS rules** in `index.html`:
  breathing on `.body`, shake on `.shaker`, the five mini gestures and the walk leans.

### Limitations this design removes

1. The motion vocabulary belonged to the classic creature. A ghost that floats or a robot
   that moves in steps could only *re-skin* the classic moves, and only from an SVG
   avatar's CSS, only by out-specifying built-in rules.
2. Image avatars had no CSS at all — no way to bind any motion.
3. State changes were abrupt attribute swaps: no anticipation, no enter animation, and a
   creature frozen by the idle pause stayed stuck mid-squash.
4. Subagents popped in and vanished with no spawn/despawn motion.
5. Adding or tuning any movement meant editing `index.html`.

## The architecture

Three separated responsibilities:

| Layer | Owns | Lives in |
|---|---|---|
| Activity state | states, load, sessions/subagents | `packages/core` (unchanged) |
| **Animation behavior** | which animation plays per state, on which part, how fast, how strong | `apps/widget/web/behavior.js` (new) |
| Avatar rendering | appearance: pictures, SVG, skin CSS, anchors | `avatar.js` + `.claudepet` packages (unchanged format, one new optional section) |

`behavior.js` is **data plus one pure function**:

- A *behavior map*: `state → { target, keyframes, duration, easing, amplitude, enter }`.
- Built-in **motion profiles** (`classic`, `floaty`, `mechanical`) — the same map shaped
  for a different character feel.
- `compileBehavior(map) → CSS string`. The page compiles the default map once at startup
  into `<style id="behavior-css">`, and recompiles on avatar switch with the avatar's
  optional `animations` manifest section merged in, scoped to
  `.critter[data-avatar="<id>"]`.

The `@keyframes` library itself stays static CSS in `index.html`; avatars may also bind
their own keyframes from `skin.css` (already sanitized and renamed `av-<id>-<name>`).

### Why this stays cheap

- **Zero per-frame JavaScript.** Compilation runs at startup and on avatar switch only.
  The compiled stylesheet is ordinary CSS; the compositor does the rest, exactly as today.
- **The freeze keeps covering everything.** The compiler never emits
  `animation-play-state` and never emits `!important`, so the global pause rules still
  stop every animation, built-in or avatar-defined.
- **Enter phases are event-driven.** A state change adds a short-lived `.enter` class;
  one delegated `animationend`/`animationcancel` listener on `#pet` removes it. No
  timers, no scheduler, nothing runs while nothing happens.
- **No injection surface.** The compiler builds CSS from typed, range-checked tokens
  (enum targets, clamped numbers, validated keyframe names). No manifest string is ever
  concatenated into the stylesheet.

### The declarative `animations` manifest section (optional)

```json
"animations": {
  "profile": "floaty",
  "states": {
    "THINKING": { "target": "body", "keyframes": "bob", "dur": 2600, "ease": "ease-in-out", "amp": 1.2 },
    "CODING":   { "target": "body", "keyframes": "wiggle", "dur": "auto" },
    "DONE":     { "enter": { "keyframes": "tip", "dur": 900, "count": 2 } },
    "ERROR":    { "fallback": "HIGH_LOAD" }
  }
}
```

- `target`: `root | shaker | body | eyes` — the wrapper groups both the SVG contract and
  generated image-avatar skeletons guarantee.
- `keyframes`: a name from the avatar's own `skin.css` or from the built-in library.
  Unknown name ⇒ the entry is dropped and the default behavior stands.
- `dur`: milliseconds (clamped), or `"auto"` = the widget's load-driven speed (`--dur`).
- `ease`: a keyword or 4 cubic-bezier numbers (clamped).
- `amp`: a bounded multiplier compiled to `--amp-k`; built-in keyframes scale by
  `var(--amp) * var(--amp-k, 1)`. Avatars never see raw load.
- `enter`: a one-shot played on entering the state (`count` bounded, never infinite).
- `fallback`: reuse another state's entry.

The vocabulary (targets, easings, ranges, name pattern) is declared once in
`packages/collector/src/avatar-format.json` and enforced three times: by the TS tooling at
pack time, by Rust at import **and** every load, and by the page compiler as the final
gate. An avatar without an `animations` section behaves exactly as before.

### Decisions worth recording

- **Enter phases yes, exit phases no.** Exit animations require delaying the state swap
  behind a scheduler — a timer, a queue, and a creature lying about the engine's state.
  The next state's enter one-shot (settle, flinch, hop) gives the same perceived
  continuity, and the engine's `minStateMs` already damps flapping.
- **Rest pose instead of mid-squash freeze.** IDLE declares *no loop*: the animation is
  removed, the creature snaps to its specified pose, and a short `settle` enter smooths
  the landing. The `*`-pause rules stay as the universal backstop.
- **`@media` stays refused in avatar CSS.** The page-level reduced-motion kill switch
  already stops avatar animations; widening the one parser that guards the chat IPC buys
  nothing.
- **The walk stays JS.** Only the lean/step bindings come from the profile, so a floaty
  avatar glides instead of step-bouncing; the locomotion model is not a creator surface.
- Rejected: Web Animations API and any JS-driven motion (bypasses the pause backstop),
  a diffing rewrite of `renderCritters` (regression risk for a cosmetic gain), a format
  version bump (`animations` is additive under `format: 1`).

## Performance budget and measurement

Targets (M-series Mac, share of one core): idle **< 1 %** with zero running animations;
one active creature **≤ ~3.5 %**; several subagents **≤ ~4.5 %** (the documented
baseline); widget + WebKit XPC RSS **≤ ~85 MB**; the behavior layer itself adds one
compiled stylesheet and nothing per frame.

`npm run bench -- <quiet | moderate | heavy>` samples the running widget (plus its WebKit
XPC helpers, attributed by start time, and the daemon) at 1 Hz, drives the simulator for
the active scenarios, and reports avg/max CPU and RSS. It refuses to run without the
widget, and a `quiet` run reports how many spool events arrived — a quiet run with
events in it is labelled contaminated, not reported as idle.

### Baseline (before the behavior layer)

Recorded 2026-10-18 on an M1 MacBook Air, widget built from `265d6e7` (main), 60 s per
scenario at 1 Hz, via `npm run bench`:

| Scenario | widget+XPC CPU avg / max | widget+XPC RSS avg / max | daemon CPU avg | spool events |
|---|---|---|---|---|
| quiet (0 events, engine idle) | **0.2 % / 1.4 %** | 186 MB / 186 MB | 0.0 % | 0 |
| moderate (simulator, 102 events) | **15.3 % / 24.0 %** | 193 MB / 198 MB | 0.9 % | 102 |
| heavy, subagents (607 events) | **20.7 % / 27.3 %** | 216 MB / 229 MB | 1.2 % | 607 |

⚠️ **Not comparable to the README table.** These numbers sum the widget process **and its
three WebKit XPC helpers** (WebContent does the actual compositing work), and sum their
`ps` RSS (shared pages counted more than once). The README's "~3.5 % / ~85 MB" counted
the widget process alone on a different machine. This table is the self-consistent
reference the after-measurements in this series compare against — same tool, same
machine, same scenarios, same seed.

### After (the whole series: behavior layer, enters, manifest animations, profiles)

Same machine, same tool, same seeds, widget built from `c513240`, measured 2026-10-18
under `caffeinate -i` (a first run was discarded: the Mac idle-slept mid-run and
stretched it — wall-clock gaps distort `ps` sampling; measure awake):

| Scenario | CPU avg / max | vs baseline | RSS avg |
|---|---|---|---|
| quiet (0 events) | **0.1 % / 1.2 %** | 0.2 % / 1.4 % ✓ | 271 MB † |
| quiet, fresh process (control) | **0.1 % / 0.5 %** | — | **179 MB** (baseline 186) ✓ |
| moderate (102 events) | **13.1 % / 21.8 %** | 15.3 % / 24.0 % ✓ | 241 MB † |
| heavy, subagents (607 events) | **19.5 % / 26.2 %** | 20.7 % / 27.3 % ✓ | 261 MB † |

† Measured on a process that had just absorbed ~50 minutes of continuous stress runs:
WebKit grows caches it does not return. The fresh-process control (179 MB, below the
186 MB baseline) is the honest steady-state memory number; the behavior layer itself is
one compiled stylesheet. Every CPU row improved: the rest pose means IDLE now runs
**zero** animations instead of paused ones, and the enter one-shots replaced nothing
heavier than what was already looping.

Gates: idle < 1 % with no running animation ✓ · active ≤ baseline ✓ · multi-subagent ≤
baseline ✓ · no new timers, listeners per creature, or rAF (two delegated listeners on
`#pet` in total) ✓.

## Implementation sequence

1. **This document + `scripts/bench.ts` + recorded baseline** (no product code).
2. **`behavior.js` + compiler** — pure refactor; a snapshot test pins the compiled
   classic behavior to the exact CSS it replaces.
3. **Enter one-shots, rest pose, kid spawn/despawn, reduced-motion cleanup.**
4. **Schema + validation (TS, Rust, page) + CSS for image avatars.**
5. **Classic polish + `floaty`/`mechanical` profiles + ghost as the proof** that a
   different character moves differently with zero widget-code change.
6. **Benchmarks vs the baseline + docs.**

Each stage is its own PR and can be reverted alone.
