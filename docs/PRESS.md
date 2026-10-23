# Press kit

Everything you need to write about claude-pet. All pictures and videos may be reused to talk
about the project.

## In one line

> A tiny creature on your Mac that shows what Claude Code is doing — thinking, coding,
> storming, or waiting for you.

## In a paragraph

claude-pet is a small, free, open-source creature that sits in a corner of your Mac's screen
(or in the menu bar) and shows, live, what Claude Code is doing: thinking, reading files,
writing code, running tools, storming through a big task — or waiting for your answer. Every
session gets its own creature and every subagent a little one; it tires as the context window
fills up, several sessions can orbit the one that needs you like a small galaxy, and it can
wear any look from a community avatar library.

## The longer story

Claude Code works in the background while you work in front, and the question is always the
same: is it done, is it stuck, is it asking me something? claude-pet answers at a glance. It
reads the signals Claude Code itself reports — its hooks, its status line, the network of its
own process — and turns them into a creature's moods, never an invented one. It never reads
your prompts, code or commands; nothing about you leaves your Mac. It costs about 0.2 % of a
CPU core at rest, updates itself with signed releases, and its looks come from a library
anyone can contribute to — a few pictures are enough to make an avatar.

## Facts

| | |
|---|---|
| Platform | macOS, Apple Silicon; works with Claude Code in a terminal and in VS Code |
| Install | `brew install r45635/tap/claude-pet`, then `claude-pet setup` |
| License | MIT, free and open source |
| Built with | Tauri (Rust) and TypeScript; built with Claude Code |
| Authors | Vincent Cruvellier and Chloé Cruvellier |
| Links | [github.com/r45635/claude-pet](https://github.com/r45635/claude-pet) · [avatar library](https://github.com/r45635/claude-pet-avatars) |

## Media

| | |
|---|---|
| Demo video, 34 s, square (1080×1080) | [demo-square.mp4](media/demo-square.mp4) |
| Demo video, 34 s, wide (1920×1080) | [demo-wide.mp4](media/demo-wide.mp4) |
| Social card (1280×640) | [social-preview.png](media/social-preview.png) |
| The creature at work, with subagents | [hero.gif](media/hero.gif) |
| Several sessions, one waiting for you | [sessions.gif](media/sessions.gif) |
| A storm, and why | [storm.gif](media/storm.gif) |
| The galaxy layout (sped up 4×) | [galaxy.gif](media/galaxy.gif) |
| Tired: the context is almost full | [tired.gif](media/tired.gif) |
| The eight moods | [state-*.png](media) |
| Avatars from the library | [avatar-*.gif](media) |

All are rendered from the real app's page by `scripts/media.ts` and `scripts/demo-video.ts`.

## Contact

Questions, interviews, corrections: open an [issue](https://github.com/r45635/claude-pet/issues).
