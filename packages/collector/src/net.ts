/**
 * The network sensor: how many bytes each `claude` process has received, sampled with
 * macOS `nettop`. Inbound bytes are the model streaming — thinking or writing — which no
 * hook reports. Only byte counters are read: never a host, a payload or a socket.
 *
 * Cost, measured on the MacBook Air (2026-10-03):
 *   - `nettop -L 0` (continuous): 120–134 % CPU. Unusable.
 *   - `nettop -L 1` (one shot):   ~30 ms CPU, but ~5 s wall time per call.
 * So the sensor runs one-shot calls back to back — a sample every ~5 s for ~0.6 % CPU —
 * and only while a turn is open. At rest it spawns nothing.
 */

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export type Counters = { bytesIn: number; bytesOut: number };
export type Delta = { bytesIn: number; bytesOut: number; spanMs: number };

/** `nettop -P -L 1 -p claude -J bytes_in,bytes_out -x` → pid → cumulative counters. */
export function parseNettop(output: string): Map<number, Counters> {
  const out = new Map<number, Counters>();
  for (const line of output.split('\n')) {
    const m = /^claude\.(\d+),(\d+),(\d+),?\s*$/.exec(line.trim());
    if (m) out.set(Number(m[1]), { bytesIn: Number(m[2]), bytesOut: Number(m[3]) });
  }
  return out;
}

/**
 * Per-pid deltas between two samples. A counter that went *down* means the process's
 * sockets were closed and reopened; that interval is unknowable, so it yields nothing
 * rather than a negative or a guess.
 */
export function deltas(
  previous: Map<number, Counters & { atMs: number }>,
  current: Map<number, Counters>,
  nowMs: number,
): Map<number, Delta> {
  const out = new Map<number, Delta>();
  for (const [pid, cur] of current) {
    const prev = previous.get(pid);
    if (!prev || cur.bytesIn < prev.bytesIn || cur.bytesOut < prev.bytesOut) continue;
    out.set(pid, {
      bytesIn: cur.bytesIn - prev.bytesIn,
      bytesOut: cur.bytesOut - prev.bytesOut,
      spanMs: nowMs - prev.atMs,
    });
  }
  return out;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

export class NetSensor {
  #previous = new Map<number, Counters & { atMs: number }>();
  /** hook ppid → the `claude` process above it (null: none found). Pids are stable. */
  #claudePid = new Map<number, number | null>();
  #available: boolean | null = null;

  /** Walk up from a hook's parent pid to the `claude` process (a few `ps` calls, cached). */
  async claudePidOf(ppid: number): Promise<number | null> {
    if (this.#claudePid.has(ppid)) return this.#claudePid.get(ppid)!;
    let pid = ppid;
    let found: number | null = null;
    for (let hop = 0; hop < 6 && pid > 1; hop += 1) {
      const line = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], 2_000);
      const m = line && /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (!m) break;
      if (basename(m[2]!) === 'claude') {
        found = pid;
        break;
      }
      pid = Number(m[1]);
    }
    this.#claudePid.set(ppid, found);
    return found;
  }

  /** One sample of every `claude` process. Resolves after ~5 s (nettop's own pace). */
  async sample(nowMs: () => number): Promise<Map<number, Delta> | null> {
    if (this.#available === false) return null;
    const output = await run('nettop', ['-P', '-L', '1', '-p', 'claude', '-J', 'bytes_in,bytes_out', '-x'], 15_000);
    if (output === null) {
      this.#available = false; // not macOS, or nettop refused: the sensor stays off
      return null;
    }
    this.#available = true;
    const at = nowMs();
    const current = parseNettop(output);
    const result = deltas(this.#previous, current, at);
    this.#previous = new Map([...current].map(([pid, c]) => [pid, { ...c, atMs: at }]));
    return result;
  }
}
