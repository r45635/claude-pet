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

Fully local. No cloud, no telemetry, no outbound network call anywhere in the codebase.

---

## Status

| Phase | | |
|---|---|---|
| 0 | telemetry investigation | ✅ `docs/CLAUDE_CODE_TELEMETRY.md` |
| 1 | event simulator | ✅ deterministic, 4 profiles |
| 2 | state engine + tests | ✅ |
| 3 | Tauri widget | ✅ transparent window, ~0.2% CPU / ~55 MB idle (measured) |
| 4 | real Claude Code integration | 🟡 `npm run install-hooks` — wired, engine not yet tuned on real sessions |
| 5 | refinement | ⬜ |

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
- ⚠️ **indirect:** real per-message token counts exist in the transcript JSONL, whose
  schema is internal → opt-in, off by default
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
- Node ≥ 23.6 (runs the TypeScript directly — there is no build step)
- `jq` (ships with macOS 26 at `/usr/bin/jq`)
- Rust — **only** for Phase 3; see `apps/widget/README.md`

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

## License

MIT
