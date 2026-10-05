/**
 * ~/.claude-pet/config.reference.jsonc — opened next to config.json by the menu's
 * "Advanced settings…". Every engine key, its *effective* value right now (defaults +
 * temperament + your overrides), and what it does. Regenerated on each opening and
 * written read-only: it is a manual, not a second place to configure.
 */

import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import type { EngineConfig } from '@claude-pet/core';

/** Docs by dotted path. A block doc (e.g. `channels`) covers everything under it. */
export const KEY_DOCS: Record<string, string> = {
  channels:
    'Four activity reservoirs fed by hook events. Per channel: tauMs = how long it remembers (decay, inside a turn), k = how much it takes to look busy (lower = more sensitive), weight = share in the blend, capFactor = ceiling in multiples of k.',
  eventWeights: 'How much each hook event pours into its channel. Raise one to make that activity count more.',
  subagentGaugePerSec: 'Extra load per running subagent, per second.',
  work: 'The "a turn is running" gauge (0-100) — Claude working even when no hook fires.',
  'work.max': 'Level of the gauge while Claude works. Higher = more excited at baseline.',
  'work.rampMs': 'Without the network sensor: time constant of the rise from 0 to max.',
  'work.staleAfterMs': 'Without the network sensor: no event for this long = the turn is forgotten.',
  'work.idleDecayFactor': 'After a turn ends, channels drain this many times faster (0.4 = 2.5x faster).',
  blendExponent: 'How much the loudest channel dominates the blend (1 = plain average, 2 = default).',
  smoothing: 'Inertia of the final load, as time constants.',
  'smoothing.attackMs': 'How fast it gets excited. Lower = jumpier.',
  'smoothing.releaseMs': 'How fast it calms down. Higher = more inertia.',
  highLoadThreshold: 'Load (0-100) at which the creature storms (orange, shaking).',
  highLoadExitThreshold: 'Load below which the storm ends. Keep it under highLoadThreshold to avoid flicker.',
  errorStickyMs: 'How long the error look stays after an error.',
  doneStickyMs: 'How long the "done" moment lasts after a turn ends.',
  minStateMs: 'Shortest time any state stays on screen (waking up, errors, waiting and storms show at once). Settings panel: seconds.',
  agentStaleMs: 'A subagent silent this long is dropped (background agents otherwise stay until they finish).',
  idleAfterMs: 'Silence (no turn running) before the creature falls asleep.',
  rateWindowMs: 'Window of the events/minute figures in the debug overlay.',
  sessionTtlMs: 'A session silent this long loses its pastille.',
  net: 'The network sensor (macOS): bytes arriving at a claude process = the model streaming.',
  'net.activeBytesPerSec': 'Inbound rate above which the model counts as generating (keepalives are ~20 B/s).',
  'net.freshMs': 'How long one sample (taken every ~5 s) stays valid.',
  'net.perKb': 'Load poured per KB streamed. Higher = more excited by long answers.',
  'net.quietWorkFactor': 'Share of work.max while a turn is open but nothing streams (a tool runs).',
};

const HEADER = `// claude-pet — configuration reference (read-only, regenerated each time it is opened)
//
// Values below are the ones in effect right now: defaults + temperament "%T" + your
// overrides. To change one, copy the key into config.json (same nesting) and save — it
// applies live. An explicit key in config.json always wins over the temperament.
`;

function render(value: unknown, path: string, indent: string): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const inner = `${indent}  `;
  const lines = Object.entries(value as Record<string, unknown>).map(([key, v]) => {
    const keyPath = path ? `${path}.${key}` : key;
    const doc = KEY_DOCS[keyPath];
    const comment = doc ? `${inner}// ${doc}\n` : '';
    return `${comment}${inner}${JSON.stringify(key)}: ${render(v, keyPath, inner)}`;
  });
  return `{\n${lines.join(',\n')}\n${indent}}`;
}

export function referenceText(config: EngineConfig, temperament: string): string {
  return `${HEADER.replace('%T', temperament)}\n${render(config, '', '')}\n`;
}

export function writeReference(file: string, config: EngineConfig, temperament: string): void {
  rmSync(file, { force: true }); // the previous copy is read-only
  writeFileSync(file, referenceText(config, temperament), { mode: 0o600 });
  chmodSync(file, 0o400);
}
