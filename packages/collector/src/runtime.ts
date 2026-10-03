/**
 * The glue between the spool and the pure engine. Lives here, not in `core`, so that
 * `core` stays free of I/O and therefore testable without mocks.
 */

import { Engine, mergeConfig, type PetSnapshot } from '@claude-pet/core';
import { readFileSync } from 'node:fs';
import { CONFIG_FILE } from './paths.ts';
import { SpoolTailer } from './spool.ts';

export type RuntimeOptions = {
  spoolFile?: string;
  /** Start from the beginning of the spool instead of its end. */
  fromStart?: boolean;
  /**
   * Rebuild state from the last N ms of spool before tailing, so a daemon restarted
   * mid-turn knows the turn is running (otherwise it sits IDLE until the next prompt).
   * Events are replayed *in time* — the engine is advanced to each event's timestamp
   * before ingesting it — so old bursts have decayed instead of all landing at once.
   */
  warmStartMs?: number;
  now?: () => number;
};

export function loadUserConfig(): ReturnType<typeof mergeConfig> {
  try {
    return mergeConfig(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')));
  } catch {
    return mergeConfig(undefined);
  }
}

export class Runtime {
  readonly engine: Engine;
  readonly tailer: SpoolTailer;
  readonly #now: () => number;

  constructor(options: RuntimeOptions = {}) {
    this.#now = options.now ?? Date.now;
    const config = loadUserConfig();
    const warm = options.warmStartMs ?? 0;
    this.tailer = new SpoolTailer(options.spoolFile, !options.fromStart && warm === 0);

    if (warm === 0) {
      this.engine = new Engine(this.#now(), config);
      return;
    }
    const now = this.#now();
    const recent = this.tailer.read().events.filter((e) => e.tsMs >= now - warm && e.tsMs <= now);
    let t = recent[0]?.tsMs ?? now;
    this.engine = new Engine(t, config);
    for (const event of recent) {
      t = Math.max(t, event.tsMs); // appends from parallel sessions can be out of order
      this.engine.snapshot(t);
      this.engine.ingest(event);
    }
  }

  /** Drain whatever is new in the spool into the engine. Returns how many it read. */
  pump(): number {
    const { events, dropped } = this.tailer.read();
    for (const event of events) this.engine.ingest(event);
    if (dropped > 0) this.engine.noteDrop(dropped);
    return events.length;
  }

  snapshot(): PetSnapshot {
    return this.engine.snapshot(this.#now());
  }
}
