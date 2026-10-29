# Development guide

Everything technical that the [README](../README.md) leaves out: working from a clone, how
the pet is wired into Claude Code, what it measures and how, what it costs, and the tooling.

## Contents

- [Status](#status)
- [From a clone](#from-a-clone)
- [Wiring into Claude Code](#wiring-into-claude-code)
- [Start at login](#start-at-login)
- [Updates and storage](#updates-and-storage)
- [How it works](#how-it-works)
- [The VS Code extension](#the-vs-code-extension)
- [Running it without Claude Code](#running-it-without-claude-code)
- [What it costs](#what-it-costs)
- [Tooling](#tooling)
- [Reference docs](#reference-docs)

## Status

| Phase | | |
|---|---|---|
| 0 | telemetry investigation | ✅ [`CLAUDE_CODE_TELEMETRY.md`](CLAUDE_CODE_TELEMETRY.md) |
| 1 | event simulator | ✅ deterministic, 4 profiles |
| 2 | state engine + tests | ✅ |
| 3 | Tauri widget | ✅ transparent window, clicks only on the creature, ~0.5 % CPU / ~55 MB idle (measured) |
| 4 | real Claude Code integration | 🟡 wired (hooks + network sensor); tuning on real sessions continues (`npm run replay`) |
| 5 | refinement | ✅ launch at login, sizes, one creature per agent, settings, usage gauge, chat, avatars, menu bar, fatigue, OpenTelemetry token counts, doctor |

The phase order and its rationale: [`ROADMAP.md`](ROADMAP.md).

## From a clone

Needs Node ≥ 23.6 (it runs the TypeScript directly), no Rust:

```bash
git clone https://github.com/r45635/claude-pet && cd claude-pet
npm install
npm run install-hooks            # wire it into Claude Code
npm run autostart -- install     # downloads the prebuilt widget, starts daemon + widget at login
```

`autostart install` fetches the widget of `package.json`'s version into `~/.claude-pet/bin/`
(`npm run fetch-widget` does only that step), unless you built it yourself
(`cd apps/widget && cargo tauri build --no-bundle`, see [`apps/widget/README.md`](../apps/widget/README.md)).
A local build in `apps/widget/src-tauri/target/release` always wins over the download.
`npm run build-standalone` builds the release archive locally (it needs the official Node
build from nodejs.org: Homebrew's cannot make single executables).

Requirements: macOS on Apple Silicon; `jq` (ships with macOS 26 at `/usr/bin/jq`); Rust only to
build the widget yourself.

## Wiring into Claude Code

```bash
npm run install-hooks -- --dry-run   # show what would change
npm run install-hooks                # back up ~/.claude/settings.json, then merge
npm run uninstall-hooks              # remove only our entries
```

The installer **merges**: existing hooks are left untouched, a foreign `statusLine` is never
overwritten (the meter then stays offline and says so), and a re-run is a no-op. Every write
is preceded by a backup in `~/.claude-pet/backups/`. Running sessions pick the hooks up
without a restart.

`claude-pet doctor` (from a clone: `npm run doctor`) checks each link against reality,
read-only: hooks and status line wired to scripts that exist, the daemon reachable and on
this version, its reader caught up, the widget running — and the failure no status shows,
Claude Code running with no hook event for ten minutes. Each problem comes with the command
that fixes it; the exit code is 1 when something is broken.

## Start at login

```bash
npm run autostart -- install     # daemon + widget as per-user LaunchAgents
npm run autostart -- restart     # after a pull or a rebuild: run the new code
npm run autostart -- status
npm run autostart -- uninstall
```

launchd restarts the daemon whenever it stops, and the widget only after a crash (Quit in
the menu keeps it closed until the next login). Logs are in `~/.claude-pet/logs/`. After
`git pull`, `restart`: it downloads the widget of the new version if needed.

## Updates and storage

The standalone install updates itself. Once a day the daemon asks GitHub which release is
the latest (a request carrying nothing but the URL — [`PRIVACY.md`](PRIVACY.md)). When a newer
one is out, it downloads it, checks its **signed release manifest** (ed25519, public key pinned
in the code: this tag, this file, this SHA-256), swaps it in and restarts the creature;
right-click → *Install vX…* does the same on demand. Unsigned or older releases never install.
The previous version stays in
`~/.claude-pet/app.old` — to go back:
`mv ~/.claude-pet/app ~/.claude-pet/app.bad && mv ~/.claude-pet/app.old ~/.claude-pet/app && ~/.claude-pet/app/claude-pet restart`.
A clone is never updated behind its owner's back: the menu says how and opens the release.

Nothing grows without bound: an update keeps exactly one previous version; from a clone,
`npm run autostart -- install|restart` removes every downloaded widget but the one it
launches. Logs are capped at 1 MB each (one previous kept), the event spool at 4 MB (same),
and leftovers of an interrupted download or import are swept at the next start. Everything
lives in `~/.claude-pet/`.

Homebrew: [`r45635/homebrew-tap`](https://github.com/r45635/homebrew-tap) installs the same
archive; its `claude-pet` command runs `~/.claude-pet/app/claude-pet` once `setup` has installed
it (that copy updates itself), and brew's own copy otherwise. **Each release bumps the formula**
(`url` + `sha256` in `Formula/claude-pet.rb`, then `brew audit --strict`).

The release archive (~45 MB: `claude-pet` embeds the Node runtime) is built by GitHub
Actions (`.github/workflows/release.yml`) for every version tag. The binaries are not
notarized by Apple, so download with `curl` or `gh release download`, not a browser
(Gatekeeper would quarantine it).

## How it works

```text
Claude Code hooks ──┐
                    ├──> spool (JSONL)  ──> collector daemon ──> state engine ──> SSE ──> widget
statusLine command ─┘                                                              └──> menu-bar icon
```

**Hooks say what Claude is doing. The status line says how loaded the session is.** Neither
is sufficient alone, and both are documented, supported mechanisms. The hot path is `sh` +
`jq` (~5 ms) rather than Node (~80 ms), because `PreToolUse` sits in front of every single
tool call. While a turn runs, the daemon also reads how many bytes each `claude` process
receives (`nettop`): the only live sign that the model is generating.

What is and is not available from Claude Code — and how each claim was verified — is in
[`CLAUDE_CODE_TELEMETRY.md`](CLAUDE_CODE_TELEMETRY.md). The short version:

- ✅ **documented:** tool/subagent/prompt/turn/error events (hooks), context-window %,
  token totals, cost, durations (status line)
- ⚠️ **indirect:** the transcript JSONL (internal schema) gives per-thread activity and
  real token counts → opt-in, off by default (settings → *Read conversation files*)
- 📡 **documented, opt-in:** Claude Code's OpenTelemetry logs give real output-token counts
  per API request, VS Code included → `claude-pet otel enable` (only the counts are kept)
- ❌ **unavailable:** per-tool-call token counts in a hook payload, a streaming token-rate
  API, any explicit "thinking" signal
- 🧮 **derived:** `load_score`, a visualization index that says so

The core rule: the creature shows Claude's **observable activity**, never an invented
picture of its reasoning. Every metric in the API says whether it was measured or derived,
and anything unknown is reported as `null` — never as a plausible number.

## The VS Code extension

The extension's graphical chat panel runs the hooks but not the status line. The creature
follows those sessions like any other; what the status line carries does not arrive: no
usage gauge, no context fill (so no tiredness). To get them, switch the extension to
terminal mode: VS Code settings → Extensions → Claude Code → **Use Terminal**
(`claudeCode.useTerminal`). Real token counts do reach the pet from the panel through Claude
Code's own telemetry: `claude-pet otel enable`, then open a new session
([privacy](PRIVACY.md#opentelemetry-opt-in-off-by-default)).

## Running it without Claude Code

For working on the engine or the widget, a simulator writes realistic sessions to the spool:

```bash
npm install
npm test

npm run daemon                                   # terminal 1: the local state API (prints port and token)
npm run sim -- --profile heavy --duration 30     # terminal 2: a fake heavy session, in real time
node packages/collector/src/snapshot.ts --watch  # terminal 3: watch the engine react
```

Or see the creature: `open "apps/widget/web/index.html#token=<token>&debug"`. Profiles:
`idle`, `moderate`, `heavy`, `error`; `--seed 7 --fast` replays byte-identically, `--stdout`
prints events instead of writing the spool. `npm run replay` runs the real spool through the
engine and prints statistics.

The browser harness also renders any scene without a daemon, which is how the README's
pictures are made:
`index.html#demo=avatar&state=CODING&kids=3&sessions=CODING,WAITING&ctx=92&gauge=42&size=220`.

## What it costs

Measured on an Apple Silicon Mac mini (2026-10-05), CPU as a share of one core, widget
process alone:

| | widget | daemon |
|---|---|---|
| at rest (animations stopped) | ~0.5 % (~0.2 % with nothing happening at all, [`RISKS.md`](RISKS.md) §6) | < 1 % |
| while Claude works (60 s simulated `moderate` session) | ~3.5 % (up to ~4.5 % with several subagents walking around) | < 1 % |
| memory | ~85 MB | ~90-100 MB |

The cost while active is the animation itself: macOS recomposites the transparent window on
every frame. Since v0.4 the page redraws only when what it shows changes visibly (~6 % less,
measured A/B, [`RISKS.md`](RISKS.md) §6). The daemon spawns `nettop` every ~5 s during a
turn (~1 % CPU) unless *Read conversation files* is on (~0.6 %).

`npm run bench -- <quiet|moderate|heavy>` samples the widget **plus its WebKit XPC helpers**
while driving the simulator, so its numbers run higher than this table. Measure with the
screen in use: locked, nothing is composited and the numbers mean nothing.

## Tooling

| Command | |
|---|---|
| `npm test`, `npx tsc --noEmit` | the test suite (`node --test`) and the type check |
| `npm run doctor` | check the installed chain against reality |
| `npm run otel -- status\|enable\|disable` | the opt-in OpenTelemetry source |
| `npm run avatar -- validate\|pack\|from-sheet` | avatar creator tooling ([`AVATARS.md`](AVATARS.md)) |
| `npm run avatars -- list\|install\|update\|remove` | the avatar library from a clone |
| `npm run bench -- <scenario>` | CPU/memory of the running widget |
| `npm run docs:config` | regenerate [`CONFIG.md`](CONFIG.md) from the settings schema |
| `node scripts/media.ts` | regenerate the README's pictures and the social preview (`docs/media/`, needs Chrome, ffmpeg and the avatar library cloned next to this repo) |
| `node scripts/tray-icon.ts` | regenerate the menu-bar icon |
| `node scripts/thumbs.ts [<folder>…]` | the avatar menu's pictures: Classic's (`apps/widget/src-tauri/icons/classic-thumb.png`), or each library folder's `thumb.png` (needs Chrome and the library cloned next to this repo) |

## Reference docs

| | |
|---|---|
| [`CLAUDE_CODE_TELEMETRY.md`](CLAUDE_CODE_TELEMETRY.md) | what Claude Code exposes, with the command that proves each claim |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | pipeline, why a spool file is the seam, rejected alternatives |
| [`EVENT_SCHEMA.md`](EVENT_SCHEMA.md) | the normalized `PetEvent`, and what it structurally cannot contain |
| [`LOAD_SCORE.md`](LOAD_SCORE.md) | the decaying-reservoir model, fatigue bands |
| [`MOTION.md`](MOTION.md) | the state → animation layer and how avatars extend it |
| [`MVP_SCOPE.md`](MVP_SCOPE.md) | in / out, and the definition of done |
| [`RISKS.md`](RISKS.md) | the risks, each with a mitigation and a guard |
| [`ROADMAP.md`](ROADMAP.md) | the phase order |
| [`PRIVACY.md`](PRIVACY.md) | what is never read, what is reduced, how it is enforced |
| [`CONFIG.md`](CONFIG.md) | every setting, ranges, languages, environment |
| [`AVATARS.md`](AVATARS.md) | make your own creature: the `.claudepet` format, states, the SVG contract, safety |
