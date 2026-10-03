# apps/widget — Phase 3

**Not built yet.** Two things live here:

- `dev.html` — a Rust-free harness that renders the four MVP visual states against the
  daemon's SSE feed. Open it in Safari; press `d` for the debug overlay.
- this note, recording the prerequisite the rest of the repo deliberately avoids.

## Prerequisite before Phase 3 proper

`cargo` and `rustc` are **not installed** on this machine (checked 2026-10-03). Tauri
cannot build without them:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install tauri-cli --locked
```

That is a ~1.5 GB one-time install. Phases 1, 2 and the whole collector need none of it,
which is why they come first.

## Window configuration Phase 3 will need

```jsonc
// src-tauri/tauri.conf.json (sketch)
{
  "app": { "windows": [{
    "transparent": true, "decorations": false, "alwaysOnTop": true,
    "shadow": false, "resizable": false, "skipTaskbar": true,
    "width": 180, "height": 180
  }] }
}
```

`macOSPrivateApi: true` is required for a genuinely transparent window on macOS.
Click-through is `window.setIgnoreCursorEvents(true)` — Phase 5, behind a toggle, because
a creature you cannot click is a creature you cannot move.
