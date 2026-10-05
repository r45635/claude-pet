# Privacy model

This tool watches a developer at work. The only acceptable design is one where the
sensitive data **never enters the pipeline**, not one where it enters and is then handled
carefully.

## Never read, at the source

These Claude Code hook fields are available to us and are **never extracted**:

| Field | Hook | Would leak |
|---|---|---|
| `prompt` | `UserPromptSubmit` | what the user asked |
| `tool_input` | `PreToolUse`, `PermissionRequest`, `PostToolUse` | file paths, `Bash` command lines, URLs, MCP arguments |
| `tool_result` | `PostToolUse` | file content, command output |
| `error` | `PostToolUseFailure` | stack traces, paths, secrets in messages |
| `last_assistant_message` | `Stop`, `SubagentStop` | the model's output |
| `message_text` | `MessageDisplay` | the model's output, streamed |
| `expanded_prompt` | `UserPromptExpansion` | prompt content |
| `user_response` | `ElicitationResult` | whatever was typed into a dialog |
| `transcript_path` content | all | the entire conversation (see the opt-in below) |

## Reduced before storage

| Raw | Stored | Why |
|---|---|---|
| `session_id` | first 8 chars | already an opaque random UUID, so hashing it would buy nothing and cost a `shasum` process on every tool call. Enough to correlate events from one session |
| `tool_name` | one of 11 lowercase classes | `mcp__acme__get_customer_pii` must not become a line in a file. The server name is discarded with the rest |
| `cwd`, `workspace.repo.*`, `gitBranch` | **dropped entirely** | a repo name is a client name |
| `error_type` | kept — it is a closed enum (`rate_limit`, `overloaded`, …) | no free text can appear in it |
| `notification_type` | kept — closed enum | same |
| `agent_type` | kept, lowercased | agent names are ours, not data |

## Two allow-lists, not one

1. **`claude-pet-hook.sh`** builds the output line with an explicit `jq` object construction
   (`{v, ts, type, sid, tool, n}`). There is no code path that copies an input object
   through, so a new Claude Code field cannot appear in the spool by default.
2. **`parsePetEvent()`** in `@claude-pet/core` rebuilds the event from a known key list and
   drops everything else before it reaches the engine.

Defence in depth is the point: either layer alone would be enough on a good day.

## The conversation files: opt-in, off by default

Settings → *Read conversation files* lets the daemon follow `~/.claude/projects/**/*.jsonl`,
where Claude Code writes each session and each subagent. It is the one place the pet opens
a file that holds prompts and answers, so it is **off until you turn it on**, and turning
it off stops the watcher at once.

What it keeps, per line: whose thread (session id cut to 8 chars, subagent id cut to 12,
as the hooks cut them), the line kind (`input`, `thinking`, `text`, `tool_use`) and the
output token count. Nothing else leaves `transcript.ts`: no text, no tool name, no path,
no cwd. Nothing from it is written to disk or logged; it goes to the engine in memory.

How little is read:
- user lines (prompts and tool results: most of the bytes) are recognised on their first
  bytes, where Claude Code writes `"type":"user"`, and are **never parsed**;
- assistant lines are parsed only to read their block types and usage;
- history is never read: at start the daemon notes where each existing file ends.

`packages/collector/test/transcript.test.ts` puts `CANARY_<random>` in prompts, tool
results, thinking, text, tool inputs and `cwd`, and asserts it is in no signal that comes
out.

## Nothing leaves the machine

- the collector binds `127.0.0.1` only, with a per-run token in the SSE URL;
- there is no outbound HTTP anywhere in the codebase, and no analytics dependency;
- `~/.claude-pet/` is `0700`; the spool is `0600`.

## Talking to the creature

The chat is the one place where content is involved — the user's own words, on purpose.
What you type goes to your own `claude` CLI, run by the widget (not the daemon), and lands
where any Claude Code conversation lands: its transcript under `~/.claude/projects/`. The
daemon never sees the text. The widget keeps only the exchange on screen, in memory.

## Retention

| File | Lifetime |
|---|---|
| `~/.claude-pet/spool/events.jsonl` | rotated at 4 MB, truncated on `SessionEnd`; nothing is archived |
| `~/.claude-pet/state.json` | window geometry + user settings only — no telemetry |

## The test that enforces it

`packages/collector/test/privacy.test.ts` feeds the hook script realistic payloads whose
`prompt`, `tool_input.command`, `tool_input.file_path` and `tool_result` contain the marker
`CANARY_<random>`, then asserts the marker appears in **no** byte of the produced spool line.
It is a release gate, not a nicety.
