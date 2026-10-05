/**
 * The conversation-file source (opt-in). Claude Code writes one JSONL file per session
 * under ~/.claude/projects, and one per subagent next to it. Each content block lands as
 * its own line ~0.1 s after it is complete — measured 2026-10-05, median 137 ms — so the
 * files say, per thread, whether the model is working or a tool has it, and how many
 * tokens it wrote. Undocumented format: anything unexpected yields nothing, never a guess.
 *
 * Privacy: these files hold prompts, answers and tool results. This module keeps the
 * line type, the block types and token counts, and nothing else leaves it — not stored,
 * not logged, not passed on. User lines (prompts, tool results: the bulk of the bytes)
 * are recognised on their first bytes and never parsed. See docs/PRIVACY.md.
 *
 * Cost: macOS reports changes (FSEvents, no polling); the watcher callback only marks a
 * file dirty, and the daemon reads the appended bytes on its existing tick. History is
 * never read: start() notes every existing file's size (one directory walk, no reads),
 * and a file is followed from there.
 */

import { closeSync, openSync, readdirSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { TranscriptSignal } from '@claude-pet/core';

export const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** A pending partial line longer than this is a giant tool result: skip to its end. */
const MAX_PARTIAL = 1 << 20;
/** A file untouched this long drops its per-request token memory (its offset stays). */
const FORGET_AFTER_MS = 60 * 60_000;

type Line = Omit<TranscriptSignal, 'sid' | 'aid' | 'atMs'> & { req?: string; out?: number };

/**
 * One line → what kind it is, or null. User lines are decided on their first bytes:
 * Claude Code writes `"type":"user"` before `"message"`, so a megabyte of tool result is
 * never parsed. Assistant lines are parsed to read their block type and usage.
 */
export function parseTranscriptLine(line: string): Line | null {
  const head = line.slice(0, 300);
  const user = head.indexOf('"type":"user"');
  const message = head.indexOf('"message"');
  if (user !== -1 && (message === -1 || user < message)) {
    return { kind: 'input' };
  }
  if (!line.includes('"requestId":"')) return null; // attachments, titles, modes…
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const e = entry as { type?: unknown; requestId?: unknown; message?: { content?: unknown; usage?: { output_tokens?: unknown } } };
  if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return null;
  const types = (e.message.content as { type?: unknown }[]).map((b) => b?.type);
  const kind = types.includes('tool_use') ? 'tool_use'
    : types.includes('text') ? 'text'
    : types.includes('thinking') || types.includes('redacted_thinking') ? 'thinking'
    : null;
  if (!kind) return null;
  const out = e.message.usage?.output_tokens;
  const req = typeof e.requestId === 'string' ? e.requestId : undefined;
  return { kind, ...(typeof out === 'number' && Number.isFinite(out) && out >= 0 ? { out } : {}), ...(req ? { req } : {}) };
}

/**
 * <project>/<session uuid>.jsonl                       → main thread
 * <project>/<session uuid>/subagents/agent-<id>.jsonl  → that subagent
 * Ids are cut exactly as the hooks cut them, so both sources name the same thread.
 */
export function threadOf(file: string): { sid: string; aid: string | null } | null {
  const name = basename(file, '.jsonl');
  const safe = (s: string, n: number) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
  if (name.startsWith('agent-')) {
    if (basename(dirname(file)) !== 'subagents') return null;
    const session = basename(dirname(dirname(file)));
    return { sid: safe(session, 8), aid: safe(name.slice('agent-'.length), 12) };
  }
  if (!/^[0-9a-f-]{36}$/.test(name)) return null;
  return { sid: name.slice(0, 8), aid: null };
}

type Followed = {
  offset: number;
  partial: string;
  skipping: boolean;
  /** Output tokens already counted per request: lines of one reply repeat its usage. */
  outByReq: Map<string, number>;
  touchedMs: number;
};

export class TranscriptSource {
  readonly #root: string;
  readonly #now: () => number;
  #watcher: FSWatcher | null = null;
  #startedMs = 0;
  readonly #dirty = new Set<string>();
  readonly #files = new Map<string, Followed>();

  constructor(root = PROJECTS_DIR, now: () => number = Date.now) {
    this.#root = root;
    this.#now = now;
  }

  get running(): boolean {
    return this.#watcher !== null;
  }

  start(): boolean {
    if (this.#watcher) return true;
    try {
      this.#startedMs = this.#now();
      // Where each existing file ends now: only what is written from here on is news.
      for (const rel of readdirSync(this.#root, { recursive: true }) as string[]) {
        if (!rel.endsWith('.jsonl')) continue;
        const file = join(this.#root, rel);
        try {
          this.#files.set(file, { offset: statSync(file).size, partial: '', skipping: false,
                                  outByReq: new Map(), touchedMs: this.#startedMs });
        } catch { /* gone meanwhile */ }
      }
      this.#watcher = watch(this.#root, { recursive: true }, (_event, rel) => {
        if (rel && rel.endsWith('.jsonl')) this.#dirty.add(join(this.#root, rel));
      });
      this.#watcher.on('error', () => this.stop());
      return true;
    } catch {
      this.#watcher = null; // no ~/.claude/projects: the source simply stays off
      return false;
    }
  }

  stop(): void {
    this.#watcher?.close();
    this.#watcher = null;
    this.#dirty.clear();
    this.#files.clear();
  }

  /** Read what was appended to the files that changed since the last call. */
  drain(sink: (signal: TranscriptSignal) => void): number {
    if (!this.#watcher || this.#dirty.size === 0) return 0;
    const now = this.#now();
    let count = 0;
    for (const file of this.#dirty) {
      const thread = threadOf(file);
      if (!thread) continue;
      for (const line of this.#appended(file, now)) {
        const parsed = parseTranscriptLine(line);
        if (!parsed) continue;
        const outTokens = this.#newTokens(file, parsed);
        sink({ sid: thread.sid, aid: thread.aid, atMs: now, kind: parsed.kind, ...(outTokens ? { outTokens } : {}) });
        count += 1;
      }
    }
    this.#dirty.clear();
    for (const f of this.#files.values()) if (now - f.touchedMs > FORGET_AFTER_MS) f.outByReq.clear();
    return count;
  }

  #appended(file: string, now: number): string[] {
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      this.#files.delete(file);
      return [];
    }
    let f = this.#files.get(file);
    if (!f) {
      // Not there at start: a new session or subagent, every line of it is news.
      f = { offset: 0, partial: '', skipping: false, outByReq: new Map(), touchedMs: now };
      this.#files.set(file, f);
    }
    f.touchedMs = now;
    if (size < f.offset) f = Object.assign(f, { offset: 0, partial: '', skipping: false }); // rewritten
    if (size === f.offset) return [];
    const buf = Buffer.alloc(size - f.offset);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, buf.length, f.offset);
    } finally {
      closeSync(fd);
    }
    f.offset = size;
    const parts = (f.partial + buf.toString('utf8')).split('\n');
    f.partial = parts.pop() ?? '';
    const lines: string[] = [];
    for (const part of parts) {
      if (f.skipping) { f.skipping = false; continue; } // tail of a skipped giant line
      if (part) lines.push(part);
    }
    if (f.partial.length > MAX_PARTIAL) {
      f.partial = '';
      f.skipping = true;
    }
    return lines;
  }

  #newTokens(file: string, line: Line): number {
    if (line.out === undefined || !line.req) return 0;
    const f = this.#files.get(file);
    if (!f) return 0;
    const before = f.outByReq.get(line.req) ?? 0;
    if (line.out <= before) return 0;
    f.outByReq.set(line.req, line.out);
    if (f.outByReq.size > 64) f.outByReq.delete(f.outByReq.keys().next().value!);
    return line.out - before;
  }
}
