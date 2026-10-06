# claude-pet

A small always-visible creature on macOS that visualizes what Claude Code is **observably
doing** during a coding session: idle, thinking, reading, coding, running tools, under a
token storm, waiting on you, done, or in trouble.

> **The core rule of this project**
>
> The creature is a visualization of Claude's **observable activity**, not a fake
> representation of Claude's internal reasoning. Every metric in the API says whether it
> was measured or derived, and anything unknown is reported as `null` — never as a
> plausible number.

Fully local. No cloud, no telemetry, no outbound network call at runtime. The one exception
is installing from a clone: a one-time download of the prebuilt widget from this
repository's GitHub Releases, checked against its published SHA-256 (skipped if you build
it yourself).

---

## Status

| Phase | | |
|---|---|---|
| 0 | telemetry investigation | ✅ `docs/CLAUDE_CODE_TELEMETRY.md` |
| 1 | event simulator | ✅ deterministic, 4 profiles |
| 2 | state engine + tests | ✅ |
| 3 | Tauri widget | ✅ transparent window, ~0.2% CPU / ~55 MB idle (measured) |
| 4 | real Claude Code integration | 🟡 `npm run install-hooks` — wired, engine not yet tuned on real sessions |
| 5 | refinement | 🟡 launch at login, sizes, one creature per session and subagent, settings, usage-limit gauge |

## Install

On an Apple Silicon Mac. Nothing to install first — no Node, no Rust, no clone:

```bash
curl -fsSLO https://github.com/r45635/claude-pet/releases/latest/download/claude-pet-aarch64-apple-darwin.tar.gz
tar -xzf claude-pet-aarch64-apple-darwin.tar.gz
./claude-pet/claude-pet setup
```

`setup` copies the app to `~/.claude-pet/app` (the download can then be deleted), wires the
hooks into Claude Code and starts the pet at login. To update, run the same three lines
again. `~/.claude-pet/app/claude-pet` also has `status`, `restart`, `snapshot` and
`uninstall` (which keeps your settings and logs).

The archive (~45 MB: `claude-pet` embeds the Node runtime) is built by GitHub Actions
(`.github/workflows/release.yml`) for every version tag. Download it with `curl`, not a
browser: the binaries are not notarized by Apple, and a browser download would be
quarantined by Gatekeeper. While the repository is private, `curl` cannot see it; use
`gh release download -R r45635/claude-pet -p claude-pet-aarch64-apple-darwin.tar.gz`.

### From a clone

For working on the pet. Needs Node ≥ 23.6, no Rust:

```bash
git clone https://github.com/r45635/claude-pet && cd claude-pet
npm install
npm run install-hooks            # wire it into Claude Code
npm run autostart -- install     # downloads the prebuilt widget, starts daemon + widget at login
```

`autostart install` fetches the widget of `package.json`'s version into `~/.claude-pet/bin/`
(`npm run fetch-widget` does only that step), unless you built it yourself.
`npm run build-standalone` builds the release archive locally (needs the official Node
build from nodejs.org: Homebrew's cannot make single executables).

## Try it without Claude Code

```bash
npm install
npm test

# terminal 1 — the local state API
npm run daemon          # prints its port and token

# terminal 2 — a fake heavy session, in real time
npm run sim -- --profile heavy --duration 30

# terminal 3 — watch the engine react
node packages/collector/src/snapshot.ts --watch
```

Or see the creature: `open "apps/widget/web/index.html#token=<token>&debug"`, or run the Tauri widget (`apps/widget/README.md`).

Profiles: `idle`, `moderate`, `heavy`, `error`. Add `--seed 7 --fast` for a byte-identical
replay; `--stdout` to print events instead of writing the spool.

## How it works

```text
Claude Code hooks ──┐
                    ├──> spool (JSONL)  ──> collector daemon ──> state engine ──> SSE ──> widget
statusLine command ─┘
```

**Hooks say what Claude is doing. The status line says how loaded the session is.** Neither
is sufficient alone, and both are documented, supported mechanisms. The hot path is `sh` +
`jq` (~5 ms) rather than Node (~80 ms), because `PreToolUse` sits in front of every single
tool call.

What is and is not available from Claude Code — and how each claim was verified — is in
[`docs/CLAUDE_CODE_TELEMETRY.md`](docs/CLAUDE_CODE_TELEMETRY.md). The short version:

- ✅ **documented:** tool/subagent/prompt/turn/error events (hooks), context-window %,
  token totals, cost, durations (status line)
- ⚠️ **indirect:** the transcript JSONL (internal schema) gives per-thread activity and
  real token counts → opt-in, off by default (settings → *Read conversation files*)
- ❌ **unavailable:** per-tool-call token counts in a hook payload, a streaming token-rate
  API, any explicit "thinking" signal
- 🧮 **derived:** `load_score`, which is a visualization index and says so

## Privacy

Prompts, file contents, paths, command lines and tool output are **never read** — not
stored-then-filtered, never extracted in the first place. Two independent allow-lists
enforce it (the hook's `jq` construction, then `parsePetEvent`), and
`packages/collector/test/privacy.test.ts` is a release gate that feeds poisoned payloads
through the real scripts and asserts the markers appear nowhere.

Details: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Docs

| | |
|---|---|
| [`CLAUDE_CODE_TELEMETRY.md`](docs/CLAUDE_CODE_TELEMETRY.md) | Phase 0 — what Claude Code exposes, with the command that proves each claim |
| [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) | pipeline, why a spool file is the seam, rejected alternatives |
| [`EVENT_SCHEMA.md`](docs/EVENT_SCHEMA.md) | the normalized `PetEvent`, and what it structurally cannot contain |
| [`LOAD_SCORE.md`](docs/LOAD_SCORE.md) | the decaying-reservoir model, and why the blend is a power mean |
| [`MVP_SCOPE.md`](docs/MVP_SCOPE.md) | in / out, and the definition of done |
| [`RISKS.md`](docs/RISKS.md) | nine risks, each with a mitigation and a guard |
| [`ROADMAP.md`](docs/ROADMAP.md) | the phase order and why it survives this machine |
| [`PRIVACY.md`](docs/PRIVACY.md) | what is never read, what is reduced, how it is enforced |

## Requirements

- macOS, Apple Silicon
- from a clone only: Node ≥ 23.6 (runs the TypeScript directly); the standalone release
  embeds its own
- `jq` (ships with macOS 26 at `/usr/bin/jq`)
- Rust — **only** to build the widget yourself; otherwise the prebuilt one is downloaded.
  See `apps/widget/README.md`

## What you see

- **One creature per Claude Code session**, each with its subagents wandering around it
  (up to 4 shown; one in trouble or waiting on you is never the hidden one).
- **A tray under the feet**: one pastille per session, and the plan's usage gauge — how
  much of the current 5-hour window is used (green, amber from 70 %, red from 90 %) and
  the time left before it resets. It comes from the status line, so it only shows on a
  Claude.ai plan, not with an API key.
- **A why bubble** above the head in a storm or an error (`42 tool calls/min`,
  `Bash failed`, `Rate limited`).
- **Settings** (gear icon in the chat bubble): the creatures' size (80 to 300 px),
  storm threshold and minimum time per state, applied live, and *Read conversation files* (off by default): each subagent then shows
  its own model working or its tool running, and token counts are real. Only line kinds
  and token counts are kept, never text — see [`PRIVACY.md`](docs/PRIVACY.md). Size
  presets, temperament and the rest are in the right-click menu.

## Talk to it

Click the creature: a bubble opens; type (or use macOS dictation) and press Enter. The widget
runs your own `claude` CLI headless in `~/.claude-pet/chat`, one continuous conversation,
answer streamed into the bubble — and the creature animates from that session like any
other. It is a **full agent** (`--permission-mode auto`): see `docs/RISKS.md` §10. Drag to
move, right-click for the menu (New conversation, Chat model, Stop, …).

## Wiring into Claude Code

```bash
npm run install-hooks -- --dry-run   # show what would change
npm run install-hooks                # back up ~/.claude/settings.json, then merge
npm run uninstall-hooks              # remove only our entries
```

The installer **merges**: existing hooks are left untouched, a foreign `statusLine` is never
overwritten (the meter then stays offline and says so), and a re-run is a no-op. Every write
is preceded by a backup in `~/.claude-pet/backups/`. Running sessions pick the hooks up
without a restart. The proof it works is `wc -l ~/.claude-pet/spool/events.jsonl` growing.

## Start at login

```bash
npm run autostart -- install     # daemon + widget as per-user LaunchAgents
npm run autostart -- restart     # after a pull or a rebuild: run the new code
npm run autostart -- status
npm run autostart -- uninstall
```

launchd restarts the daemon whenever it stops, and the widget only after a crash (Quit in
the menu keeps it closed until the next login). Logs are in `~/.claude-pet/logs/`. After
`git pull`, `restart`: it downloads the widget of the new version if needed. A local build
(`apps/widget/src-tauri/target/release`) always wins over the download, so if you build it
yourself, rebuild after a pull that changed `apps/widget`.

## What it costs

Measured on an Apple Silicon Mac mini (2026-10-05), CPU as a share of one core:

| | widget | daemon |
|---|---|---|
| at rest (animations stopped) | ~0.5 % (~0.2 % with nothing happening at all, per `docs/RISKS.md` §6) | < 1 % |
| while Claude works (60 s simulated `moderate` session) | **~3.5 %** (up to ~4.5 % with several subagents walking around) | < 1 % |
| memory | ~85 MB | ~90-100 MB |

The widget's cost while active is the animation itself: macOS recomposites the
transparent window on every frame. It has been there from the first version (4.2 % on the
same benchmark before the per-agent creatures; 3.4 % now). The daemon spawns `nettop`
every ~5 s during a turn (~1 % CPU) unless *Read conversation files* is on, which brings
it to ~0.6 %.

Lowering the active cost would mean lighter animations (fewer creatures moving at once,
fewer steps, fewer full-window effects); not done yet.

## License

MIT
