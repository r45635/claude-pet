# apps/widget — Phase 3

- `web/index.html` — the creature. The same page runs in two hosts:
  - the Tauri window, which injects `window.__CLAUDE_PET__ = {url, token}` read from
    `~/.claude-pet/endpoint.json` and renders it transparent;
  - any browser, as a Rust-free harness:
    `open "apps/widget/web/index.html#token=<token>&debug"`. Press `d` for the debug overlay.
- `src-tauri/` — a transparent, undecorated, always-on-top 180×180 window, no Dock icon.
  Its only capability is `start-dragging`: no fs, shell or network plugin.

## Build and run

Needs Rust and the Tauri CLI (one-time, ~1.5 GB):

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
`npm run autostart -- install`.

## Right-click menu

| Item | Effect |
|---|---|
| Temperament → Zen / Normal / Nervous | presets for what excites the creature, when it storms, how fast it calms down (`TEMPERAMENTS` in `packages/core/src/config.ts`) |
| Size → Small / Medium / Large | window and creature size |
| Session pastilles | show/hide one dot per live Claude Code session |
| Pause (sleep) | the creature sleeps; the network sensor stops sampling |
| Advanced settings… | opens `~/.claude-pet/config.json` (yours to edit) next to `config.reference.jsonc` (read-only: every key, its effective value, what it does) |
| Quit claude-pet | closes the widget until the next login (or `launchctl kickstart`) |

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
