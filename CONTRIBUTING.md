# Contributing to claude-pet

Thanks for wanting to help! There are three good ways in.

## 🎨 Design an avatar

The easiest and most visible contribution: a new look for the creature. Avatars live in their
own repository, **[claude-pet-avatars](https://github.com/r45635/claude-pet-avatars)** — a few
pictures, an SVG or a sprite sheet is enough. Start with its contributing guide.

## 🐞 Report a bug

Open an issue with the **Bug report** template. The most useful thing you can paste is the
output of:

```bash
~/.claude-pet/app/claude-pet doctor
```

It checks every link between Claude Code and the creature and says which one is broken.

## 🛠 Send a change

The [development guide](docs/DEVELOPMENT.md) explains how to run everything from a clone
(Node ≥ 23.6; Rust only for the widget). Before opening a pull request:

```bash
npm test && npx tsc --noEmit                 # the TypeScript side
cd apps/widget/src-tauri && cargo test       # the widget, if you touched it
```

A few rules the project holds to — the [privacy model](docs/PRIVACY.md) explains why:

- **Observable only.** The creature shows what Claude Code reports, never an invented mood;
  an unknown value is `null`, not a guess.
- **Never read content.** No prompt, code, path, command or output may reach the spool, a log
  or the screen.
- **Cheap in the hot path.** Hooks run before every tool call: they stay `sh` + `jq`.
- **Commit identity:** CI accepts GitHub noreply addresses only
  (`git config user.email "<id>+<login>@users.noreply.github.com"`).

Small, focused pull requests are easiest to review. For anything big, open an issue first so
we can agree on the approach.
