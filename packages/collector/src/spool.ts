/**
 * The spool: an append-only JSONL file that decouples the hooks from the daemon.
 *
 * Why a file and not a socket: a hook must never fail, block or care whether the daemon
 * is running, and a `write()` under PIPE_BUF (4 KB on macOS) to an O_APPEND fd is atomic,
 * so parallel tool calls cannot interleave a line. See docs/ARCHITECTURE.md.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
} from 'node:fs';
import { parseSpoolLine, type PetEvent } from '@claude-pet/core';
import { SPOOL_DIR, SPOOL_FILE, SPOOL_MAX_BYTES, ROOT_DIR } from './paths.ts';

export function ensureSpool(): void {
  mkdirSync(SPOOL_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(ROOT_DIR, { recursive: true, mode: 0o700 });
}

/** Append one already-normalized event. Used by the simulator and by tests. */
export function appendRaw(line: string, file = SPOOL_FILE): void {
  ensureSpool();
  appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 });
}

export function rotateIfNeeded(file = SPOOL_FILE): boolean {
  try {
    if (statSync(file).size < SPOOL_MAX_BYTES) return false;
  } catch {
    return false;
  }
  renameSync(file, `${file}.1`);
  return true;
}

export function truncateSpool(file = SPOOL_FILE): void {
  try {
    truncateSync(file, 0);
  } catch {
    /* nothing to truncate */
  }
}

export type TailResult = { events: PetEvent[]; dropped: number };

/**
 * Reads new bytes from the spool, remembering a byte offset so a daemon restart resumes
 * where it stopped. Detects truncation/rotation (file shrank) and restarts from 0.
 */
export class SpoolTailer {
  readonly file: string;
  #offset: number;
  #partial = '';

  constructor(file = SPOOL_FILE, startAtEnd = true) {
    this.file = file;
    this.#offset = startAtEnd && existsSync(file) ? statSync(file).size : 0;
  }

  get offset(): number {
    return this.#offset;
  }

  read(): TailResult {
    const out: TailResult = { events: [], dropped: 0 };
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return out; // No spool yet: not an error, just nothing to say.
    }

    if (size < this.#offset) {
      // Truncated or rotated under us.
      this.#offset = 0;
      this.#partial = '';
    }
    if (size === this.#offset) return out;

    const fd = openSync(this.file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(size - this.#offset);
      const read = readSync(fd, buffer, 0, buffer.length, this.#offset);
      this.#offset += read;
      const chunk = this.#partial + buffer.subarray(0, read).toString('utf8');
      const lines = chunk.split('\n');
      // A trailing fragment means a writer is mid-append; keep it for next time.
      this.#partial = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        const event = parseSpoolLine(line);
        if (event) out.events.push(event);
        else out.dropped += 1;
      }
    } finally {
      closeSync(fd);
    }
    return out;
  }
}
