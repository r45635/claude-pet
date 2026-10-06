# apps/widget — Phase 3

- `web/index.html` — the creature. The same page runs in two hosts:
  - the Tauri window, which injects `window.__CLAUDE_PET__ = {url, token}` read from
    `~/.claude-pet/endpoint.json` and renders it transparent;
  - any browser, as a Rust-free harness:
    `open "apps/widget/web/index.html#token=<token>&debug"`. Press `d` for the debug overlay.
- `src-tauri/` — a transparent, undecorated, always-on-top 180×180 window, no Dock icon.
  Its only capability is `start-dragging`: no fs, shell or network plugin.

## Prebuilt

Users do not build it: `npm run autostart -- install` downloads the binary GitHub Actions
built for this version (`.github/workflows/release.yml`). To publish a version: bump it in
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (the workflow
refuses a mismatch), merge, then push the tag `v<version>`. A pull request that touches
the widget gets a build too, kept as a workflow artifact, without a release.

## Build and run

To work on the widget. Needs Rust and the Tauri CLI (one-time, ~1.5 GB):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
cargo install tauri-cli --locked
```

Then, with the daemon already running (the widget reads its endpoint **at startup**):

```bash
npm run daemon                                   # terminal 1
cd apps/widget && cargo tauri build --no-bundle  # once
./src-tauri/target/release/claude-pet-widget
```

Daemon and widget share a persistent token (`~/.claude-pet/token`), so either can restart
without the other: the widget reconnects on its own. To start both at login:
`npm run autostart -- install`. After a pull or a rebuild, `npm run autostart -- restart`
has launchd restart both on the new code (`status` and `uninstall` also exist).

## Right-click menu

| Item | Effect |
|---|---|
| Temperament → Zen / Normal / Nervous | presets for what excites the creature, when it storms, how fast it calms down (`TEMPERAMENTS` in `packages/core/src/config.ts`) |
| Size → Small / Medium / Large | window and creature size: 110, 150, 220 px (any size from 80 to 300 px with the slider in the settings panel) |
| Session pastilles | show/hide one dot per live Claude Code session |
| Pause (sleep) | the creature sleeps; the network sensor stops sampling |
| Advanced settings… | opens `~/.claude-pet/config.json` (yours to edit) next to `config.reference.jsonc` (read-only: every key, its effective value, what it does) |
| Quit claude-pet | closes the widget until the next login (or `launchctl kickstart`) |

## One creature per agent

With one Claude Code session and no subagent, there is one creature, as before. Otherwise
each session gets its own creature, and each of its subagents a smaller one at its feet,
showing what *that* agent is doing (from the `agent_id` Claude Code puts on a subagent's
tool events). Everything is scaled to fit the creature's usual square, never larger. Up
to 4 subagents are drawn per session, then `+n`; one in error or waiting on you is
always among those drawn. Hover a small one for its agent type.

Each session is a family: the parent in the middle, its subagents wandering around it
at random — each walks somewhere (little steps, leaning the way it goes, behind the
parent or in front of it), stops to do the gesture of what it is doing (reading: nods,
coding: taps, a tool: hammers, thinking: floats, done: a jump), then sets off again.
The busier the session, the faster they walk and the shorter they pause. A family
where everyone sleeps is fully still, with no timer running; the macOS "reduce motion"
setting stops the walks and gestures. Background agents
keep their creature while you chat and after the turn that launched them: the parent
then shows it is waiting on them instead of falling asleep. The "why" bubble stays full
size and floats above the family it is about, an agent's error first ("Explore: Bash
failed"), then a session's error, then a storm.

## Settings (click the creature, then the gear)

| Setting | Effect |
|---|---|
| Storm threshold (30–100) | load at which the creature storms; it calms down 10 points lower. Overrides the temperament until reset |
| Minimum time per state (0–10 s) | each look stays at least this long, so a quick "done" can be seen. Waking up, errors, questions and storms still show at once |

Every choice is written by the daemon to `~/.claude-pet/config.json` and applied **live**,
as are hand edits to that file. Explicit engine overrides in the file always win over the
temperament preset.

Drag the creature anywhere to move it. Click-through
(`window.setIgnoreCursorEvents(true)`) is Phase 5, behind a toggle, because a creature you
cannot click is a creature you cannot move.
