# Technical risks

Ordered by how likely they are to cost real time.

## 1. Hook latency sits in front of every tool call — 🔴 high impact

`PreToolUse` is synchronous. Anything slow here taxes every single tool call in every
session on the machine, forever.

- **Measured:** `node -e 0` ≈ 80 ms, `jq -n 1` < 10 ms on this MacBook Air.
- **Mitigation:** the hot path is `sh` + `jq` + one `>>` append. No node, no network, no lock.
- **Guard:** the hook has a hard `timeout` in `settings.json` and ends in `|| true` — a
  broken pet must never be able to block or fail a tool call.
- **Residual:** ~5 ms × ~50 tool calls/turn ≈ 0.25 s per turn. Acceptable; documented so it
  can be re-measured rather than re-argued.

## 2. Rust toolchain is absent on this machine — 🟠 blocks Phase 3

`cargo` and `rustc` are not installed (verified). Tauri cannot build without them.

- **Mitigation:** Phases 1, 2 and the collector need **no Rust at all** — that ordering is
  partly why the brief's sequence is the right one. Phase 3 begins with
  `rustup` + `cargo install tauri-cli`, a ~1.5 GB one-time install.
- **Guard:** `apps/widget` ships with a plain-HTML dev harness that runs in Safari against
  the same SSE endpoint, so the creature's animation work is not gated on Rust either.

## 3. The transcript schema is internal and will drift — 🟠 medium

Real `tokens_per_minute` exists only there (verified: `assistant.message.usage` is complete
and accurate). The file also carries 13 undocumented `type` values.

- **Mitigation:** off by default; `sources.transcript: false`; when off the field is `null`,
  never estimated.
- **Guard:** the parser validates shape per line and silently drops, so a schema change
  degrades the pet to "no token rate" instead of crashing or, worse, reporting nonsense.

## 4. The status line is a UI slot we are borrowing — 🟠 medium

Claude Code **cancels an in-flight status-line script** when a new update arrives, and
blanks the bar if the script prints nothing.

- **Mitigation:** the script prints the user's real status line *first*, emits the
  `METER_SAMPLE` append *second*, and is a single atomic append (never read-modify-write),
  so a cancellation can only ever lose one sample.
- **Residual:** if the user already has a custom status line, ours must *wrap* it, not
  replace it. `install` detects an existing `statusLine.command` and refuses rather than
  overwriting.

## 5. Mistaking "wired" for "working" — 🔴 high, and the classic

A spool file that exists, a daemon that answers `200`, a green `npm test` — none of these
prove events are arriving from a real session. This project has three independent ways to
look alive while being fed nothing.

- **Mitigation:** every health check asserts a **counter moving**, not a status: spool line
  count growing, `last_activity_at` recent, `sources.*` flags true.
- **Guard:** the snapshot publishes `sources`; the widget shows a distinct "no signal" look.
  A sleeping creature and a disconnected creature must not look the same.

## 6. Idle CPU cost of an always-visible animation — 🟡 medium

A creature on screen all day that burns 3% CPU is a worse tool than no creature.

- **Mitigation:** CSS/SVG animations only (compositor-driven, no JS rAF loop); the daemon
  ticks at 100 ms only while events are flowing and drops to 1 s when idle; the webview
  pauses animations on `IDLE`.
- **Budget:** < 1% CPU idle, < 60 MB for the widget.
- **Measured 2026-10-03 (MacBook Air M1, 4 processes: widget + 3 WebKit XPC):** with the
  breathing animation still looping in `IDLE`, **~8.5% CPU / ~64 MB** — macOS recomposites
  the whole transparent window every frame. With every animation paused in `IDLE` and
  "no signal", and the DOM touched only when the snapshot changes: **~0.2% CPU / ~55 MB**.
  ⇒ Any always-visible transparent window must be fully still when nothing happens.

## 7. Privacy regression by accident — 🟠 medium, high consequence

One careless `jq '.'` in a hook would dump `tool_input` — file paths, command lines, prompt
text — into a plaintext spool.

- **Mitigation:** two independent allow-lists (hook `jq` extraction, then `parsePetEvent`
  key stripping).
- **Guard:** a test that feeds realistic hook payloads containing marker secrets through the
  hook script and asserts the markers appear nowhere in the output. See `docs/PRIVACY.md`.

## 8. Multiple concurrent sessions — 🟡 low for the MVP

Several Claude Code windows append to one spool.

- **Mitigation:** `sid` on every event; the MVP tracks the most recently active session and
  says so. The engine is already per-session internally, so a multi-pet view is additive.

## 9. Claude Code upgrades changing documented fields — 🟡 low

Documented fields are stable, but `v2.1.288` is a fast-moving product.

- **Mitigation:** the closing check in `docs/CLAUDE_CODE_TELEMETRY.md`, run after upgrades.
- **Guard:** `statusline` fields are read with `// null` fallbacks throughout; a missing
  field yields `null`, which the UI renders as "unknown".

## 10. A full agent one click away — 🔴 high consequence

Talking to the creature runs `claude -p --permission-mode auto`: it can edit files and run
commands, with nobody there to answer a permission prompt.

- **Rejected design:** a `POST /ask` route on the daemon. A localhost endpoint that starts a
  full agent is a local code-execution surface for anything that learns the token — and the
  daemon answers browsers (`access-control-allow-origin: *`) and used to print the token in
  its log. Claude Code's own safety classifier refused to build it; that was right.
- **Mitigation:** the widget spawns `claude` itself, behind Tauri IPC that only its own
  webview can call. No port exposes the agent. The token is no longer logged (and was
  rotated after the change).
- **Guards:** `auto` mode (Claude Code's classifier) rather than `bypassPermissions`; one run
  at a time; a stop button; a dedicated working folder `~/.claude-pet/chat` — which Bash
  can still leave, so it is a default, not a sandbox.
