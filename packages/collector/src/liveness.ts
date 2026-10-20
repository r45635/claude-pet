/**
 * Which sessions' `claude` process has exited. A closed terminal, a kill or a crash never
 * sends SessionEnd: the creature used to stay on screen for sessionTtlMs (30 min).
 *
 * Every hook event carries `ppid`, the hook's parent pid. Measured (2026-10-19, Claude Code
 * 2.1.301, CLI and VS Code): it is the `claude` process itself. That is a fact about how
 * Claude Code spawns hooks, not a promise, so a pid only counts as the session's process
 * once `ps` has said so (`anchored`); a launcher that ran hooks through a short-lived shell
 * would give pids that die in milliseconds, and those are never judged.
 *
 * Sessions replayed from the spool at startup (warm start) may have exited while the
 * daemon was down: their pid was never seen alive. They are judged dead only once some
 * other session proved that ppids are `claude` processes on this machine (`direct`), and
 * only if their last event predates the daemon — a session active since then is alive by
 * definition.
 *
 * Cost: one kill(pid, 0) per session per check (no process), plus one `ps` per new pid.
 */

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export type Probe = {
  /** kill(pid, 0): false only when no such process exists (EPERM = alive, not ours). */
  alive(pid: number): boolean;
  /** Is this pid a `claude` process right now? */
  isClaude(pid: number): Promise<boolean>;
};

export const systemProbe: Probe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  isClaude(pid) {
    return new Promise((resolve) => {
      execFile('ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2_000, encoding: 'utf8' }, (err, out) =>
        resolve(!err && basename(out.trim()) === 'claude'));
    });
  },
};

export type Target = { sid: string; ppid: number; lastMs: number };

export class Liveness {
  #probe: Probe;
  #startedMs: number;
  /** ppid → whether `ps` saw it as a claude process. */
  #checked = new Map<number, boolean>();
  /** Some session's ppid was its claude process: ppids are direct on this machine. */
  #direct = false;

  constructor(startedMs: number, probe: Probe = systemProbe) {
    this.#startedMs = startedMs;
    this.#probe = probe;
  }

  /** The sids whose process is known to be gone. Never a guess: unknown = alive. */
  async gone(targets: Target[]): Promise<string[]> {
    const out: string[] = [];
    for (const { sid, ppid, lastMs } of targets) {
      if (this.#probe.alive(ppid)) {
        if (!this.#checked.has(ppid)) {
          const claude = await this.#probe.isClaude(ppid);
          this.#checked.set(ppid, claude);
          if (claude) this.#direct = true;
        }
        continue;
      }
      const seen = this.#checked.get(ppid);
      if (seen === true || (seen === undefined && this.#direct && lastMs < this.#startedMs)) out.push(sid);
      this.#checked.delete(ppid); // bounded: forgotten with its process
    }
    return out;
  }
}
