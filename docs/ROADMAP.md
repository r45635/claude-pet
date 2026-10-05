# Implementation sequence

Each phase has an exit criterion that is a *check someone can run*, not a feeling.

| Phase | Work | Needs Rust? | Exit criterion |
|---|---|---|---|
| **0** ✅ | telemetry investigation | no | `docs/CLAUDE_CODE_TELEMETRY.md` states, per signal, documented / indirect / unavailable / estimated |
| **1** | event simulator | no | `npm run sim -- --profile heavy --seed 7` twice produces byte-identical spool output |
| **2** | state engine + tests | no | `npm test` green; `heavy` → `load > 75` & `HIGH_LOAD` within 5 s; back under 25 within 15 s of silence — asserted in a test |
| **3** | Tauri widget, 4 visual states | **yes** | creature visibly reacts to a simulator run; `< 1 %` CPU idle, `< 60 MB` RSS, both measured |
| **4** | real Claude Code integration | no | spool line count grows during a real session; `sources.hooks` and `sources.statusline` both true; closing check passes |
| **5** 🟡 | refinement | — | done: launch at login, sizes, one creature per session and per subagent, settings panel, usage-limit gauge. Left: artwork, click-through, menu bar, fatigue behaviour, themes, opt-in transcript/OTEL token rates |

## Order rationale

Phases 1 and 2 are first **and need no Rust**, which is the whole reason the ordering
survives contact with this machine (`cargo` is absent). Phase 3 is the first one that has to
pay the ~1.5 GB toolchain install, and by then the thing it renders is already proven
correct and already drivable by `curl`.

Phase 4 comes after 3 rather than before because wiring hooks into
`~/.claude/settings.json` is the only step that touches the user's working environment, and
it should happen when there is something to look at — and when `install` has already been
written to back up the file and merge with the two memory-hub hooks already configured there.

## Current status

Phase 0 complete. Phases 1 and 2 implemented in this first iteration. Phase 3 scaffolded
only (`apps/widget` holds the Rust-free dev harness; no Tauri project yet).
