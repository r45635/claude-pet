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

⚠️ The daemon picks a fresh token on every start unless `CLAUDE_PET_TOKEN` is set; restart
the widget after restarting the daemon, or pin the token.

Drag the creature anywhere to move it. Click-through
(`window.setIgnoreCursorEvents(true)`) is Phase 5, behind a toggle, because a creature you
cannot click is a creature you cannot move.
