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
    this.engine = new Engine(this.#now(), loadUserConfig());
    this.tailer = new SpoolTailer(options.spoolFile, !options.fromStart);
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
