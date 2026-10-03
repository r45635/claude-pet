# Architecture

## Pipeline

```text
Claude Code session
  │
  ├─ hooks (sh + jq, ~5 ms)            ─┐
  └─ statusLine command (sh + jq)      ─┤
                                        ▼
                         spool  ~/.claude-pet/spool/events.jsonl
                         append-only JSONL, one normalized event per line
                                        │
                                        ▼
                         collector daemon  (node, TypeScript)
                           · tails the spool (fs.watch + offset)
                           · defensive parse → PetEvent | drop
                           · feeds the state engine on a 100 ms tick
                                        │
                                        ▼
                         state engine  (@claude-pet/core — pure, no I/O)
                           events + clock → PetSnapshot
                           { state, load, context_load, rates, sources }
                                        │
                      ┌─────────────────┴─────────────────┐
                      ▼                                   ▼
        GET /events (SSE, 127.0.0.1)             GET /snapshot (one-shot JSON)
                      │
                      ▼
              widget (Tauri 2 + plain TS/SVG)
```

## Why this shape

**The spool file is the seam.** It is the single design decision everything else follows
from, so it is worth justifying:

- **No port in the hot path.** Hooks are short-lived processes fired dozens of times per
  turn. An append to a file cannot fail because a daemon is down, a port is taken, or a
  socket was left stale by a crash.
- **It decouples lifetimes.** Claude Code sessions outlive the widget and vice versa. The
  daemon can restart and resume from its byte offset; the hook never knows or cares.
- **Atomicity is free.** `>>` on a POSIX file with a single `write()` under `PIPE_BUF`
  (4 KB on macOS) is atomic. Our events are ~150 bytes. Two concurrent hooks from parallel
  tool calls cannot interleave a line.
- **It is trivially debuggable.** `tail -f` is the whole observability story.

Rejected alternatives are recorded in [`out-of-scope`](#rejected-alternatives) below.

**The state engine is pure.** `step(events, nowMs)` → snapshot. No clock access, no file
system, no network. This is what makes Phase 2 testable with `node --test` and no mocks,
and it is why the simulator (Phase 1) can drive the exact same code path as a real session.

**The UI never sees a Claude Code field name.** The widget consumes `PetSnapshot` only. If
Anthropic renames `tool_name` tomorrow, the change is confined to one adapter file.

## Repository layout

```text
claude-pet/
├── packages/
│   ├── core/              # @claude-pet/core — event schema, state engine, load score
│   │   ├── src/
│   │   │   ├── events.ts          # PetEvent union + type guards + defensive parse
│   │   │   ├── load.ts            # decaying-reservoir load score
│   │   │   ├── state.ts           # state machine
│   │   │   ├── engine.ts          # Engine: ingest() + snapshot()
│   │   │   └── config.ts          # weights, taus, thresholds (all tunable)
│   │   └── test/                  # node --test, zero deps
│   ├── collector/         # hook + statusline adapters, spool tailer, local API
│   │   ├── bin/
│   │   │   ├── claude-pet-hook.sh         # the hot path (sh + jq)
│   │   │   └── claude-pet-statusline.sh   # status line + METER_SAMPLE emitter
│   │   └── src/
│   │       ├── spool.ts           # append / tail-with-offset / rotate
│   │       ├── daemon.ts          # engine + SSE server
│   │       └── install.ts         # writes hook config into settings.json
│   └── simulator/         # Phase 1 — synthetic sessions, no Claude Code needed
├── apps/
│   └── widget/            # Phase 3 — Tauri 2 shell, placeholder SVG creature
├── config/
│   └── default.json       # user-overridable weights/thresholds/window geometry
├── docs/
└── scripts/
```

This differs from the brief's suggested tree in two ways, both deliberate:

1. **`state-engine/` folded into `packages/core/`.** The event schema and the state engine
   share the same types and are always versioned together; splitting them creates a
   package boundary with one consumer and no independent lifecycle. Premature abstraction
   is on the brief's own banned list.
2. **`assets/` dropped for now.** The MVP artwork is inline SVG in the widget. An `assets/`
   directory with nothing in it invites someone to start drawing before Phase 2 passes.

## Technology choices

| Choice | Reason |
|---|---|
| **npm workspaces** | already installed (npm 11.6.2); pnpm/bun are absent on this machine |
| **TypeScript run directly by Node 25** | `node file.ts` works via type stripping — verified. No build step, no bundler, no watch mode for collector/core |
| **`node --test`** | native test runner, zero dev dependencies |
| **`typescript` as the only devDependency** | `tsc --noEmit` for typechecking only |
| **`sh` + `jq` for hooks** | ~5 ms vs ~80 ms for Node — measured; see `CLAUDE_CODE_TELEMETRY.md` |
| **Tauri 2** | brief preference; ~5 MB binary and a system WKWebView vs Electron's ~100 MB and its own Chromium. Needed for transparent/borderless/always-on-top/click-through, all first-class in Tauri's window config |
| **localhost SSE for the UI** | `EventSource` is 3 lines in the webview, auto-reconnects, and is readable with `curl`. A Unix socket would need a Tauri-side bridge to reach the webview — more Rust for no gain |

## Local communication — the recommendation

**Spool file for ingest, localhost SSE for egress.** Two different problems, two different
answers:

- *ingest* needs to be cheap, lossless and daemon-independent → append-only file;
- *egress* needs to be push, one-to-few, and consumable by a browser engine → SSE on
  `127.0.0.1:<port>` with a token in the URL.

No database, no Redis, no Docker, no queue. Persistence is two files: the spool (rotated at
4 MB, truncated on session end) and `~/.claude-pet/state.json` (window position + user
settings only).

## Rejected alternatives

| Option | Verdict |
|---|---|
| Node script as the hook command | **rejected** — 80 ms × every tool call, measured |
| Unix domain socket for ingest | **rejected** — hooks would fail or block when the daemon is down; stale socket files after a crash; no replay |
| WebSocket for egress | **rejected** — bidirectional protocol for a one-way feed; SSE reconnects for free |
| Electron | **rejected** — brief preference, and ~20× the RSS for a creature that must idle at near-zero cost |
| Reading the transcript JSONL as the primary source | **rejected as default** — undocumented schema; kept as an opt-in source for real token rates |
| Process/CPU inspection | **rejected** — measures the machine, not Claude |
| OTEL as the backbone | **rejected for MVP** — 60 s default export interval; opt-in in Phase 5 |
