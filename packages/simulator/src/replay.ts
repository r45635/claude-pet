#!/usr/bin/env node
/**
 * Replay a real session from the spool through the engine, and summarise how the creature
 * would have behaved. The tool for tuning EngineConfig against reality, not the simulator.
 *
 *   npm run replay                       # the session with the most events
 *   npm run replay -- --sid 237bf4a8     # a given session
 *   npm run replay -- --config '{"work":{"max":65}}'   # try an override
 *
 * Reads only the spool, which carries no content (docs/PRIVACY.md).
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Engine, mergeConfig, parseSpoolLine, type PetEvent } from '@claude-pet/core';
import { SPOOL_FILE } from '@claude-pet/collector';

const { values } = parseArgs({
  options: {
    sid: { type: 'string' },
    config: { type: 'string' },
    file: { type: 'string', default: SPOOL_FILE },
  },
});

const all = readFileSync(values.file!, 'utf8')
  .split('\n')
  .map(parseSpoolLine)
  .filter((e): e is PetEvent => e !== null);

const counts = new Map<string, number>();
for (const e of all) if (e.sid) counts.set(e.sid, (counts.get(e.sid) ?? 0) + 1);
const sid = values.sid ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const events = all.filter((e) => e.sid === sid).sort((a, b) => a.tsMs - b.tsMs);
if (events.length === 0) {
  process.stderr.write(`no events for session ${sid ?? '(none)'} in ${values.file}\n`);
  process.exit(1);
}

const config = values.config ? mergeConfig(JSON.parse(values.config)) : undefined;
const engine = new Engine(events[0]!.tsMs, config);
const TICK = 100;
let cursor = 0;
let turnTicks = 0;
let sum = 0;
let ge40 = 0;
let ge75 = 0;
let visualChanges = 0;
let jumps = 0;
let previousVisual = '';
let previousLoad = 0;
const states: Record<string, number> = {};

for (let now = events[0]!.tsMs; now <= events.at(-1)!.tsMs + 5_000; now += TICK) {
  while (cursor < events.length && events[cursor]!.tsMs <= now) engine.ingest(events[cursor++]!);
  const s = engine.snapshot(now);
  if (s.visual !== previousVisual) visualChanges += 1;
  if (Math.abs(s.load - previousLoad) >= 10) jumps += 1;
  previousVisual = s.visual;
  previousLoad = s.load;
  if (!s.debug.turn_active) continue;
  turnTicks += 1;
  sum += s.load;
  if (s.load >= 40) ge40 += 1;
  if (s.load >= 75) ge75 += 1;
  states[s.state] = (states[s.state] ?? 0) + 1;
}

const minutes = (turnTicks * TICK) / 60_000;
const pct = (n: number): number => (turnTicks ? Math.round((100 * n) / turnTicks) : 0);
process.stdout.write(
  `${JSON.stringify(
    {
      sid,
      events: events.length,
      turn_minutes: +minutes.toFixed(1),
      mean_load_in_turn: turnTicks ? Math.round(sum / turnTicks) : 0,
      pct_load_ge40: pct(ge40),
      pct_high_load: pct(ge75),
      visual_changes_per_min: minutes ? +(visualChanges / minutes).toFixed(1) : 0,
      load_jumps_ge10_per_min: minutes ? +(jumps / minutes).toFixed(1) : 0,
      states_pct: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, pct(v)])),
    },
    null,
    2,
  )}\n`,
);
