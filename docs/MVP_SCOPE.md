# MVP scope

## In scope

**Phase 1 — simulator** (`packages/simulator`)
- generates `PetEvent` streams for four profiles: `idle`, `moderate`, `heavy`, `error`
- writes to the real spool file, so the rest of the pipeline cannot tell it from Claude Code
- `--profile`, `--duration`, `--seed` (seeded → reproducible runs, which is what makes the
  engine tests meaningful)

**Phase 2 — state engine** (`packages/core`)
- `PetEvent` union, type guards, `parsePetEvent()` that drops instead of throwing
- 4 decaying reservoirs + asymmetric EMA → `load` 0–100 with `confidence`
- 9-state machine with sticky windows for `ERROR` and `DONE`
- `context_load` from `METER_SAMPLE`, `null` when unknown
- unit tests under `node --test`, no mocks, no fake timers library (the engine takes `now`)

**Phase 3 — minimal widget** (`apps/widget`)
- Tauri 2 window: transparent, borderless, always-on-top, draggable, position persisted
- one placeholder creature in inline SVG/CSS, **4 visual states**: `IDLE`, `ACTIVE`,
  `HIGH_LOAD`, `ERROR` (the engine's 9 states map down; the mapping is one function)
- animation intensity driven continuously by `load` — `animation-duration` and amplitude
  interpolated, not switched in steps
- debug overlay, toggleable, off by default:
  ```text
  STATE: CODING   LOAD: 72   EVENTS/MIN: 18   CTX: 34%
  ```

**Phase 4 — real integration** (`packages/collector`)
- `claude-pet-hook.sh` wired into `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `UserPromptSubmit`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`,
  `PermissionRequest`, `Notification`, `SessionStart`, `SessionEnd`, `PostCompact`
- `claude-pet-statusline.sh` printing a real status line **and** emitting `METER_SAMPLE`
- `claude-pet install` / `uninstall` that edits `~/.claude/settings.json` idempotently,
  **after backing it up**, and merges into existing hooks rather than replacing them
  (two hooks are already wired on this machine for the memory hub — clobbering them is the
  obvious way to break the user's day)

## Explicitly out of scope for the MVP

| Deferred | Phase |
|---|---|
| real artwork, sprite sheets, multiple creatures | 5 |
| click-through mode, menu-bar item, launch at login, configurable size | 5 |
| context/fatigue visual behaviour (designed now, rendered later) | 5 |
| themes | 5 |
| transcript JSONL source → real `tokens_per_minute` | 5, opt-in |
| OTEL receiver | 5, opt-in |
| multi-session view (several Claude Code windows at once) | 5 — the schema carries `sid` for it, the MVP shows the most recently active session |
| Windows / Linux, Intel Macs | not planned |
| anything that leaves the machine | never |

## Definition of done for the first iteration

The deliverable the user can check without reading code:

```bash
cd ~/Github/claude-pet
npm test                                   # engine tests green
npm run sim -- --profile heavy --duration 30   # writes to the spool
npm run snapshot                           # prints a live PetSnapshot, load climbing
```

✅ Done when: `npm test` passes, and a `heavy` simulator run drives `load` above 75 and
`state` to `HIGH_LOAD` within 5 s, then back under 25 within 15 s of the run ending —
**verified by a test, not by watching the number**.

⚠️ Not done when: the daemon starts and `/snapshot` returns `200`. A served snapshot proves
the server runs, not that events arrive. The proof is the line count of the spool growing
and `load` responding.
