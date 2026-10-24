# Security

claude-pet plugs into Claude Code on your Mac, so here is exactly what it touches, what it
reads, and how to report a problem.

## What it changes on your Mac

| Where | What | Undo |
|---|---|---|
| `~/.claude/settings.json` | adds its hook entries and a `statusLine` — and, if you turn the OpenTelemetry source on, five `env` entries — **merged** with yours (never overwritten), after a backup in `~/.claude-pet/backups/`; the file keeps its permissions | `claude-pet uninstall` removes only its own entries, OpenTelemetry ones included |
| `~/.claude/settings.json` → `env` | only if you run `claude-pet otel enable`: five OpenTelemetry variables (logs signal only) | `claude-pet otel disable` removes exactly those |
| `~/Library/LaunchAgents/dev.r45635.claude-pet.*.plist` | starts the daemon and the creature at login | `claude-pet uninstall` |
| `~/.claude-pet/` | the app, settings, logs, the event spool, avatars — all `0700` | delete the folder after `uninstall` |

Nothing is installed system-wide, and nothing needs `sudo`.

## What it reads — and never reads

The hooks receive what Claude Code sends them, and keep only **the kind** of event: a tool
class (`bash`, `read`, `edit`…), a session id cut to 8 characters, a timestamp. Your prompts,
code, file paths, command lines, tool output and Claude's answers are **never extracted** —
two independent allow-lists, and a release gate that feeds poisoned payloads through the real
scripts. Details: [docs/PRIVACY.md](docs/PRIVACY.md).

## What runs and what listens

- **The daemon** listens on `127.0.0.1` only, behind a random token stored in
  `~/.claude-pet/token` (`0600`). Writes that only the app's native side may make (turning the
  chat on, installing an update) need a header a web page cannot send.
- **Network:** once a day, and when you open the avatar menu, it asks GitHub whether a newer
  release or avatar exists — a request carrying nothing but the URL. `updatesCheck` turns it off.
- **Updates and avatars are signed:** a release installs on its own only if its checksum carries
  this project's ed25519 signature (public key pinned in the code); the avatar library's index
  is signed the same way, and each package is checked against it.
- **Avatars are untrusted files:** an imported avatar is validated, its SVG sanitized and its
  CSS scoped; it cannot run code.
- **The chat is a full Claude Code agent**, so it is **off by default** and can only be turned
  on from the native menu, after a confirmation that says so ([docs/RISKS.md](docs/RISKS.md) §10).

## Reporting a vulnerability

Please report privately, not in a public issue: **GitHub → this repository → Security →
Report a vulnerability**. You will get an answer within a few days. Please include the version
(`claude-pet version`) and the steps to reproduce.
