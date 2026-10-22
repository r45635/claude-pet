# Configuration

Everything the pet can be told lives in **one file**, `~/.claude-pet/config.json`, and
everything in it can be changed three ways:

| | How | Applies |
|---|---|---|
| **Settings panel** | right-click the creature → **Settings…** | at once |
| **Menu** | right-click: temperament, size and zoom, avatar, pastilles, pause, chat | at once |
| **The file** | right-click → **Advanced settings…** opens it next to a read-only reference | on save |

Hand edits are watched and applied live. Two safety rules:

- **An unreadable file is never written over.** With a typo (a trailing comma…), the pet keeps
  its last good config, the panel says so, and every change is refused until you fix it —
  your edits are not replaced.
- **Out-of-range values are ignored, not used.** Each value is checked against its range; a
  wrong type, a value out of range or an unknown key is left out and listed at the top of
  the reference file (and in `/health` as `config_warnings`).

## Settings

Generated from [`packages/collector/src/settings-schema.json`](../packages/collector/src/settings-schema.json)
(`npm run docs:config`). In the file, a dotted path is nesting: `ui.size.zoom` is
`{"ui": {"size": {"zoom": 1.2}}}`.

<!-- settings:start -->
| Section | In `config.json` | Values | Default | Where | What it does |
|---|---|---|---|---|---|
| General | `ui.locale` | `auto` · `en` · `fr` | `"auto"` | panel, file | Interface language. auto follows macOS. |
| General | `ui.theme` | `system` · `light` · `dark` | `"system"` | panel, file | Colours of the bubble and the settings panel. |
| General | `ui.reduceMotion` | `system` · `on` · `off` | `"system"` | panel, file | Stop every animation. system follows macOS's Reduce motion. |
| General | `ui.launchAtLogin` | `true` · `false` | `true` | panel, file | Start the daemon and the creature when you log in. |
| General | `ui.updates.check` | `true` · `false` | `true` | panel, file | Once a day, ask github.com whether a newer claude-pet (or avatar) exists. The request carries nothing but the URL (docs/PRIVACY.md). |
| General | `ui.updates.auto` | `true` · `false` | `true` | panel, file | Install a detected update by itself (standalone install only; a signed release is required). Clones are told, never touched (docs/RISKS.md #12). |
| Appearance | `ui.avatar` | an avatar id | `"classic"` | panel, file | The creature's look: classic or an installed avatar (docs/AVATARS.md). |
| Appearance | `ui.size.nominalPx` | 80–300 (step 10) | `150` | panel, file | The creature's size at 100 % zoom, in pixels. |
| Appearance | `ui.size.minPx` | 60–300 (step 10) | `80` | panel, file | Zooming out never goes below this size. |
| Appearance | `ui.size.maxPx` | 80–400 (step 10) | `300` | panel, file | Zooming in never goes above this size. |
| Appearance | `ui.size.zoom` | 0.5–2 (step 0.1) | `1` | panel, file | Zoom factor: shown size = nominal × zoom, kept between min and max. ⌘+ / ⌘− / ⌘0 on the creature. |
| Appearance | `ui.opacity` | 0.3–1 (step 0.05) | `1` | panel, file | How opaque the creature is. |
| Appearance | `ui.alwaysOnTop` | `true` · `false` | `true` | panel, file | Keep the creature above other windows. |
| Appearance | `ui.showSessions` | `true` · `false` | `true` | panel, file | One pastille per live Claude Code session under the creature. |
| Appearance | `ui.display` | `desktop` · `menubar` · `both` | `"desktop"` | panel, file | Where the creature lives: on the desktop, as an icon in the menu bar (its title the creature's state, its menu the right-click menu), or both. |
| Appearance | `ui.layout` | `grid` · `gravity` | `"grid"` | panel, file | With several sessions: a tidy grid, or gravity — the session waiting for you and the busiest one in front and in the middle, sleeping ones smaller at the back. |
| Appearance | `ui.spacing` | `tight` · `normal` · `roomy` | `"normal"` | panel, file | With several sessions on screen: how close the families stand. Tight makes them bigger, roomy leaves subagents more room to walk. |
| Appearance | `ui.wander` | `true` · `false` | `true` | panel, file | While its session works, the creature takes a small step now and then around its spot. Never at rest, never while it waits for you. |
| Appearance | `ui.fatigue` | `true` · `false` | `true` | panel, file | The creature tires as its session's context window fills (the status line's context %): a sweat drop from 70 %, worn out from 88 %. Nothing shown when the % is unknown. |
| Behaviour | `temperament` | `zen` · `normal` · `nervous` | `"normal"` | panel, file | Presets for what excites the creature, when it storms and how fast it calms down. |
| Behaviour | `highLoadThreshold` | 30–100 (step 1) | preset / engine default | panel, file | Load at which the creature storms; it calms down 10 points lower. Empty = the temperament's value. |
| Behaviour | `minStateMs` | 0–30 (step 0.5) | preset / engine default | panel, file | Shortest time a look stays on screen, in seconds. Empty = default. |
| Behaviour | `ui.paused` | `true` · `false` | `false` | panel, file | The creature sleeps; the sensors stop. |
| Sensors | `ui.sensors.net` | `true` · `false` | `true` | panel, file | Watch the bytes arriving at claude processes, to see the model think (macOS nettop, only during a turn). |
| Sensors | `ui.readTranscripts` | `true` · `false` | `false` | panel, file | Read the conversation files for per-agent activity and real token counts. Only line types and token counts are kept. |
| Sensors | `ui.sensors.otel` | `true` · `false` | `false` | panel, file | Receive Claude Code's OpenTelemetry logs for real token counts, VS Code included. Only output-token counts are kept. Needs `claude-pet otel enable` once (it adds the export settings to ~/.claude/settings.json). |
| Chat | `ui.chat.enabled` | `true` · `false` | `false` | panel (off only), menu (on, with confirmation), file | Click the creature to talk to Claude: a full agent that can edit files and run commands. Turning it on is only possible from the native menu. |
| Chat | `ui.chatModel` | `default` · `sonnet` · `haiku` | `"default"` | panel, file | Model for the creature's own Claude. |
| — | `ui.position` | `{x, y}` | preset / engine default | set by the widget | Where the creature stands on screen; saved when you drag it. |
<!-- settings:end -->

**Size.** The creature is shown at *nominal × zoom*, never smaller than *min* nor larger than
*max*. The menu's Small / Medium / Large set the nominal size (110 / 150 / 220 px); ⌘+ / ⌘− /
⌘0 (after clicking the creature) or the Size menu change the zoom by 0.1.

**Chat.** Off by default: clicking the creature talks to Claude as a **full agent** that can
edit files and run commands on your Mac without asking (Claude Code's `auto` mode). It can be
turned **off** anywhere, but **on** only from the right-click menu, after a native
confirmation — never from the page, so a hostile avatar cannot switch it on. See
[`RISKS.md`](RISKS.md) §10.

## Engine tuning

Every constant of the state engine (how fast the creature reacts, what counts as a storm…)
can be overridden at the top level of `config.json`. The reference file opened by
**Advanced settings…** lists each one with its current value and what it does; the allowed
ranges are in `settings-schema.json` (`engine`). A temperament preset applies first, then
your explicit keys, which always win.

## Environment variables

Set them when installing (`npm run autostart -- install`): they are written into the login
items, since launchd starts the pet with a bare environment.

| Variable | Default | Effect |
|---|---|---|
| `CLAUDE_PET_HOME` | `~/.claude-pet` | where the pet keeps its files |
| `CLAUDE_PET_PORT` | `8787` | the daemon's local port |
| `CLAUDE_PET_CLAUDE` | found in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` | the `claude` command the chat runs |
| `CLAUDE_PET_TOKEN` | `~/.claude-pet/token` | overrides the shared token — never written into the login items |

## Languages

The interface follows macOS (`locale: auto`) or the language picked in the panel; English
and French ship. To add one, copy `apps/widget/web/i18n/en.json` to `<code>.json`, translate
it, add it to `LANGUAGES` in `apps/widget/web/i18n.js`, to the `locale` values in
`settings-schema.json`, and to `menu.rs` (`Words::new`). A test fails if a language misses a
key. Numbers, durations, money and times are formatted by the system for that language.
Avatars may name themselves per language (`"names": {"fr": "…"}`, [`AVATARS.md`](AVATARS.md)).
The command line, the developer docs and the reference file stay in English.
