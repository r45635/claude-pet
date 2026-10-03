import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpoolTailer } from '../src/spool.ts';

const ts = '2026-10-03T19:40:00.000Z';
const line = (type: string) => `${JSON.stringify({ v: 1, ts, type })}\n`;

function tempSpool(): string {
  return join(mkdtempSync(join(tmpdir(), 'claude-pet-')), 'events.jsonl');
}

test('a missing spool is not an error, just nothing to say', () => {
  const tailer = new SpoolTailer(join(tmpdir(), 'claude-pet-does-not-exist', 'x.jsonl'));
  assert.deepEqual(tailer.read(), { events: [], dropped: 0 });
});

test('reads only new bytes and remembers the offset', () => {
  const file = tempSpool();
  writeFileSync(file, line('TOOL_STARTED'));
  const tailer = new SpoolTailer(file, false);

  let result = tailer.read();
  assert.equal(result.events.length, 1);

  result = tailer.read();
  assert.equal(result.events.length, 0, 'a second read must not re-deliver the same line');

  appendFileSync(file, line('TOOL_FINISHED') + line('TURN_COMPLETED'));
  result = tailer.read();
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['TOOL_FINISHED', 'TURN_COMPLETED'],
  );
});

test('startAtEnd skips the backlog — a daemon starting mid-session is not flooded', () => {
  const file = tempSpool();
  writeFileSync(file, line('TOOL_STARTED').repeat(50));
  const tailer = new SpoolTailer(file, true);
  assert.equal(tailer.read().events.length, 0);

  appendFileSync(file, line('TURN_COMPLETED'));
  assert.equal(tailer.read().events.length, 1);
});

test('a half-written line is held until its newline arrives', () => {
  const file = tempSpool();
  const full = line('BASH_STARTED');
  const cut = Math.floor(full.length / 2);
  writeFileSync(file, full.slice(0, cut));

  const tailer = new SpoolTailer(file, false);
  assert.equal(tailer.read().events.length, 0, 'a fragment must not be parsed');

  appendFileSync(file, full.slice(cut));
  assert.deepEqual(
    tailer.read().events.map((e) => e.type),
    ['BASH_STARTED'],
  );
});

test('truncation (session end) restarts from zero instead of going blind', () => {
  const file = tempSpool();
  writeFileSync(file, line('TOOL_STARTED').repeat(3));
  const tailer = new SpoolTailer(file, false);
  assert.equal(tailer.read().events.length, 3);

  truncateSync(file, 0);
  appendFileSync(file, line('SESSION_STARTED'));
  assert.deepEqual(
    tailer.read().events.map((e) => e.type),
    ['SESSION_STARTED'],
  );
});

test('garbage lines are dropped and counted, and do not stop the good ones', () => {
  const file = tempSpool();
  writeFileSync(
    file,
    [
      line('TOOL_STARTED'),
      '{not json\n',
      '\n',
      JSON.stringify({ v: 99, ts, type: 'TOOL_STARTED' }) + '\n',
      line('TURN_COMPLETED'),
    ].join(''),
  );
  const result = new SpoolTailer(file, false).read();
  assert.deepEqual(
    result.events.map((e) => e.type),
    ['TOOL_STARTED', 'TURN_COMPLETED'],
  );
  assert.equal(result.dropped, 2, 'the bad JSON and the wrong schema version');
});

test('warm start: a daemon restarted mid-turn knows the turn is running', async () => {
  const { Runtime } = await import('../src/runtime.ts');
  const file = tempSpool();
  const now = Date.parse('2026-10-03T20:00:00.000Z');
  const at = (msAgo: number, type: string) =>
    `${JSON.stringify({ v: 1, ts: new Date(now - msAgo).toISOString(), type, sid: 'abcd1234' })}\n`;
  writeFileSync(
    file,
    at(60 * 60_000, 'BASH_STARTED') + // an hour ago: outside the window, ignored
      at(60_000, 'PROMPT_SUBMITTED') +
      at(50_000, 'BASH_STARTED') +
      at(40_000, 'BASH_FINISHED'),
  );

  const runtime = new Runtime({ spoolFile: file, warmStartMs: 15 * 60_000, now: () => now });
  const s = runtime.snapshot();
  assert.equal(s.debug.turn_active, true, 'the open turn must survive a restart');
  assert.equal(s.debug.events_seen, 3, 'only the warm window is replayed');
  assert.ok(s.state !== 'IDLE', `mid-turn must not look asleep, got ${s.state}`);

  appendFileSync(file, at(0, 'TOOL_STARTED'));
  assert.equal(runtime.pump(), 1, 'after the warm start it tails new lines only');
});
