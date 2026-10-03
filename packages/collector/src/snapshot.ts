#!/usr/bin/env node
/**
 * One-shot: replay the whole spool through the engine and print the snapshot.
 *
 *   node packages/collector/src/snapshot.ts
 *   node packages/collector/src/snapshot.ts --watch
 *
 * This is the Phase 2 acceptance tool: no daemon, no widget, no Rust.
 */

import { Runtime } from './runtime.ts';
import { SPOOL_FILE } from './paths.ts';

const watch = process.argv.includes('--watch');
const spoolFile = process.env.CLAUDE_PET_SPOOL ?? SPOOL_FILE;
const runtime = new Runtime({ spoolFile, fromStart: true });

function line(): string {
  runtime.pump();
  const s = runtime.snapshot();
  const context = s.context_load === null ? ' ctx —' : ` ctx ${s.context_load}%`;
  return (
    `${s.state.padEnd(10)} load ${String(s.load).padStart(3)}` +
    ` (conf ${s.load_confidence.toFixed(2)})` +
    ` ev/min ${String(s.estimated_activity_rate).padStart(4)}` +
    ` tools/min ${String(s.tool_calls_per_minute).padStart(3)}` +
    ` agents ${s.active_subagents}` +
    context +
    ` | hooks:${s.sources.hooks ? 'y' : 'n'} sl:${s.sources.statusline ? 'y' : 'n'}` +
    ` seen ${s.debug.events_seen} dropped ${s.debug.events_dropped}`
  );
}

if (!watch) {
  runtime.pump();
  process.stdout.write(`${JSON.stringify(runtime.snapshot(), null, 2)}\n`);
} else {
  process.stderr.write(`watching ${spoolFile} — ctrl-c to stop\n`);
  setInterval(() => process.stdout.write(`${line()}\n`), 500);
}
