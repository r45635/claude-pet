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
  pauses animations on `IDLE`. The state → animation bindings compile from data
  (`web/behavior.js`, docs/MOTION.md); the compiler never emits `animation-play-state` or
  `!important` (test-pinned), so the pause rules keep covering every binding, avatar-defined
  ones included, and `IDLE` itself binds **no** animation (rest pose, nothing to pause).
  Enter one-shots and kid spawn/despawn ride `animationend` — no timers.
- **Budget:** < 1% CPU idle, < 60 MB for the widget.
- **Measured 2026-10-03 (MacBook Air M1, 4 processes: widget + 3 WebKit XPC):** with the
  breathing animation still looping in `IDLE`, **~8.5% CPU / ~64 MB** — macOS recomposites
  the whole transparent window every frame. With every animation paused in `IDLE` and
  "no signal", and the DOM touched only when the snapshot changes: **~0.2% CPU / ~55 MB**.
  ⇒ Any always-visible transparent window must be fully still when nothing happens.
- **Active cost, 2026-10-20 (MacBook Air M1, on battery, widget + 3 XPC, cumulative CPU
  time over a 45 s simulated `moderate` session):** ~15.7 % of one core with the screen in
  use. Half of it is the animation (all of them off: ~7 %); the rest was the page itself —
  the engine moves `load` every 100 ms tick, and each move re-rendered the page and rewrote
  `--amp`, read by every running animation. The page now draws load in steps of 5 and
  applies the prefs only when they change: **~14.7 % (A/B, two pairs)**. The remainder is
  macOS compositing the window at every animation frame; lowering it means fewer frames
  (stepped easing) — a visible change, not taken.
  🪤 **Measure with the screen in use.** Locked or asleep, nothing is composited: the same
  page measured 9.6 % then 2.0 %, and every comparison across a lock was noise. Pair A/B
  runs back to back and check the lock state.

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
- **Off by default (v0.3.0), gated natively:** `chat_ask` (Rust) reads `ui.chat.enabled` from
  `config.json` at every question and refuses unless it is `true`. The page can turn it off
  but never on, so a compromised page or avatar cannot re-enable it; turning it on is the
  native menu's "Enable chat…", after a native confirmation that says what it means.
  Enforced twice: Rust's `update_prefs` refuses `chatEnabled: true`, **and** the daemon
  refuses any native-only write (schema `nativeOnly`/`nativeOnlyTrue`) that lacks the
  `X-Claude-Pet-Native` header — which only Rust sends, and a webview cannot (a custom header
  needs a CORS preflight; the daemon refuses every preflight). Until 2026-10-18 only the Rust
  check existed: the page holds the daemon token, so a direct `fetch` POST could have turned
  the chat on. Verified closed in headless Chrome (header request blocked, plain one 403).
- **Guards:** `auto` mode (Claude Code's classifier) rather than `bypassPermissions`; one run
  at a time; a stop button; a dedicated working folder `~/.claude-pet/chat` — which Bash
  can still leave, so it is a default, not a sandbox.

## 11. An avatar is someone else's file — 🔴 high consequence

A `.claudepet` comes from anywhere, and the widget's page holds the chat's IPC: a full agent
(§10). A script smuggled into an avatar's SVG could drive it.

- **Mitigation:** one set of rules (`packages/collector/src/avatar-format.json`) enforced at
  import and at load (flat names, zip-slip refused, sizes bounded before reading, file types
  checked by content); SVG through an allow-list sanitizer (`web/avatar.js`); CSS scoped to the
  avatar, no `@import`/`@font-face`/`@media`/escapes/external `url()`.
- **The library** (`packages/collector/src/catalog.ts`): its `index.json` must verify against
  the pinned release key (no unsigned fallback) and each package must match the index's
  SHA-256 — that gates *distribution*. The package is then imported by Rust exactly like a
  drop — that gates *content*. The daemon downloads but never unzips; its install route is
  native-only (§10) and only serves ids from the verified catalog; Rust only imports from the
  daemon's own `.avatar-dl-*` folder, and refuses a package that installs another id.
- **Guard:** `npm run test:avatar-sanitizer` (14 poisoned SVGs, none may survive) and a
  Content-Security-Policy on the window, so a missed case still cannot reach the network;
  catalog tests (unsigned/tampered/foreign-key index, malformed entries, swapped package).

## 12. Downloaded releases are a supply chain — 🟠 medium, high consequence

Release assets are built in GitHub Actions and downloaded by `curl` without quarantine
(the binaries are ad-hoc signed, not notarized — Gatekeeper never sees them). A `.sha256`
from the same release page proves integrity in transit, nothing more.

- **Mitigation:** tag builds sign every `.sha256` with an ed25519 key held as an Actions
  secret (`scripts/sign-release.ts` → `.sig`); the collector verifies against the public key
  pinned in `packages/collector/src/widget.ts` (canonical copy: `release-pubkey.pem`).
  An invalid signature always refuses the install; a missing one (releases that predate
  signing) warns and proceeds for a manual fetch, and never qualifies for automatic install.
- **What the signature proves — and does not:** it proves the artifact came out of this
  repository's CI holding the secret (or from the key's owner). It does **not** protect
  against a compromised GitHub account, a compromised Actions runner, or a malicious commit
  that CI faithfully builds and signs; and the binaries remain un-notarized.
- **The updater** (`packages/collector/src/update.ts`): automatic install happens only on
  the standalone layout, only for a release whose signature verifies; the archive is fully
  verified and unpacked before `~/.claude-pet/app` is touched, the previous version is kept
  as `app.old`, and a failure is reported (`/health`, the creature's bubble), never silent.
  A clone is never modified: the creature only tells its owner how to pull. An unsigned
  release needs a human's confirmation in a native dialog. `POST /update` is native-only
  as a whole (the `X-Claude-Pet-Native` header, §10): the page can neither trigger an install
  nor consent to an unsigned one.
- **The settings are page-writable on purpose:** the worst a compromised page could do is
  turn automatic install on — of a release signed by the pinned key from the pinned
  repository. It cannot point the updater anywhere else.
- **Guard:** tag builds fail if the secret is absent; tests pin the signing step, the
  pubkey/pem identity, the verify/refuse behavior, and the installer's refusals (tampered
  checksum, bad or foreign signature, incomplete archive, unsigned without consent) — in
  each case the installed version is left untouched.
