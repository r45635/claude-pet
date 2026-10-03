import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { parsePetEvent, type PetEvent } from '../src/events.ts';
import { generateSession } from '../../simulator/src/generate.ts';
import type { ProfileName } from '../../simulator/src/profiles.ts';

function event(type: string, atMs: number, extra: Record<string, unknown> = {}): PetEvent {
  const parsed = parsePetEvent({ v: 1, ts: new Date(atMs).toISOString(), type, ...extra });
  assert.ok(parsed, `fixture ${type} must parse`);
  return parsed;
}

/**
 * Replay a generated session through the engine at a fixed tick, as the daemon does.
 * Returns the snapshot at each tick so a test can assert on the whole trajectory
 * instead of on one lucky instant.
 */
function replay(profile: ProfileName, durationMs: number, seed: number, tailMs = 0) {
  const events = generateSession({ profile, durationMs, seed, startMs: 0 });
  const engine = new Engine(0);
  const snapshots: { atMs: number; load: number; state: string }[] = [];
  let cursor = 0;
  const tick = 100;
  for (let now = 0; now <= durationMs + tailMs; now += tick) {
    while (cursor < events.length && events[cursor]!.tsMs <= now) {
      engine.ingest(events[cursor]!);
      cursor += 1;
    }
    const snapshot = engine.snapshot(now);
    snapshots.push({ atMs: now, load: snapshot.load, state: snapshot.state });
  }
  return { snapshots, engine, events };
}

test('the fresh engine reports absence as absence, not as zero', () => {
  const snapshot = new Engine(0).snapshot(1_000);
  assert.equal(snapshot.state, 'IDLE');
  assert.equal(snapshot.load, 0);
  assert.equal(snapshot.context_load, null, 'unknown context must be null, not 0');
  assert.equal(snapshot.tokens_per_minute, null, 'token rate must be null when unmeasured');
  assert.equal(snapshot.session.cost_usd, null);
  assert.deepEqual(snapshot.sources, {
    hooks: false,
    statusline: false,
    transcript: false,
    otel: false,
  });
});

test('every derived field is named in `estimated`', () => {
  const snapshot = new Engine(0).snapshot(0);
  for (const field of ['load', 'estimated_activity_rate', 'tool_calls_per_minute']) {
    assert.ok(snapshot.estimated.includes(field), `${field} must be declared as estimated`);
  }
  assert.ok(
    !snapshot.estimated.includes('context_load'),
    'context_load is measured from a documented field and must not be marked estimated',
  );
});

// This is the MVP acceptance criterion from docs/MVP_SCOPE.md, asserted rather than
// eyeballed: a heavy session must look frantic quickly, and must calm down afterwards.
test('MVP criterion: heavy load reaches HIGH_LOAD within 5s and settles within 15s', () => {
  const durationMs = 30_000;
  const { snapshots } = replay('heavy', durationMs, 7, 20_000);

  const firstFive = snapshots.filter((s) => s.atMs <= 5_000);
  const peak = Math.max(...firstFive.map((s) => s.load));
  assert.ok(peak > 75, `load should exceed 75 within 5s, peaked at ${peak}`);
  assert.ok(
    firstFive.some((s) => s.state === 'HIGH_LOAD'),
    'state should reach HIGH_LOAD within 5s',
  );

  const settled = snapshots.find((s) => s.atMs === durationMs + 15_000);
  assert.ok(settled);
  assert.ok(
    settled.load < 25,
    `load should fall under 25 within 15s of the session ending, got ${settled.load}`,
  );
  assert.equal(settled.state, 'IDLE');
});

test('an idle session never looks busy', () => {
  const { snapshots } = replay('idle', 60_000, 3);
  const peak = Math.max(...snapshots.map((s) => s.load));
  assert.ok(peak < 55, `an idle profile should stay calm, peaked at ${peak}`);
  assert.ok(
    !snapshots.some((s) => s.state === 'HIGH_LOAD'),
    'an idle profile must never reach HIGH_LOAD',
  );
});

test('profiles are ordered by load: idle < moderate < heavy', () => {
  const mean = (profile: ProfileName) => {
    const { snapshots } = replay(profile, 60_000, 11);
    return snapshots.reduce((acc, s) => acc + s.load, 0) / snapshots.length;
  };
  const idle = mean('idle');
  const moderate = mean('moderate');
  const heavy = mean('heavy');
  assert.ok(idle < moderate, `idle (${idle.toFixed(1)}) < moderate (${moderate.toFixed(1)})`);
  assert.ok(moderate < heavy, `moderate (${moderate.toFixed(1)}) < heavy (${heavy.toFixed(1)})`);
});

test('the error profile actually shows distress on screen', () => {
  const { snapshots } = replay('error', 60_000, 5);
  const errorTicks = snapshots.filter((s) => s.state === 'ERROR').length;
  assert.ok(errorTicks > 0, 'the error profile must produce visible ERROR states');
});

test('subagent counting survives interleaved start/stop and never goes negative', () => {
  const engine = new Engine(0);
  engine.ingest(event('SUBAGENT_STARTED', 100, { agent: 'explore' }));
  engine.ingest(event('SUBAGENT_STARTED', 200, { agent: 'plan' }));
  assert.equal(engine.snapshot(300).active_subagents, 2);
  engine.ingest(event('SUBAGENT_FINISHED', 400, { agent: 'explore' }));
  engine.ingest(event('SUBAGENT_FINISHED', 500, { agent: 'plan' }));
  engine.ingest(event('SUBAGENT_FINISHED', 600, { agent: 'ghost' }));
  assert.equal(engine.snapshot(700).active_subagents, 0, 'must not go negative');
});

test('SESSION_ENDED clears in-flight state rather than leaving it stuck', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 100));
  engine.ingest(event('SUBAGENT_STARTED', 200, { agent: 'explore' }));
  engine.ingest(event('PERMISSION_WAITING', 300, { tool: 'bash' }));
  assert.equal(engine.snapshot(400).state, 'WAITING');
  engine.ingest(event('SESSION_ENDED', 500, { reason: 'other' }));
  const after = engine.snapshot(600);
  assert.equal(after.state, 'IDLE');
  assert.equal(after.active_subagents, 0);
  assert.equal(after.debug.turn_active, false);
});

test('METER_SAMPLE feeds the gauges and contributes no load', () => {
  const engine = new Engine(0);
  engine.ingest(
    event('METER_SAMPLE', 100, {
      meter: {
        context_used_pct: 34,
        context_window: 200_000,
        in_tokens: 68_400,
        out_tokens: 1_200,
        cost_usd: 1.2345,
        lines_added: 156,
        lines_removed: 23,
      },
    }),
  );
  const snapshot = engine.snapshot(200);
  assert.equal(snapshot.load, 0, 'a gauge must never drive the animation');
  assert.equal(snapshot.context_load, 34);
  assert.equal(snapshot.session.tokens, 69_600);
  assert.equal(snapshot.session.cost_usd, 1.2345);
  assert.equal(snapshot.sources.statusline, true);
  assert.equal(snapshot.sources.hooks, false, 'a meter sample is not a hook event');
});

test('a null context_used_pct stays null — unknown is not 0%', () => {
  const engine = new Engine(0);
  engine.ingest(event('METER_SAMPLE', 100, { meter: { context_used_pct: null, in_tokens: 10 } }));
  const snapshot = engine.snapshot(200);
  assert.equal(snapshot.context_load, null);
  assert.equal(snapshot.sources.statusline, true, 'the sample still arrived');
});

test('tokens_per_minute stays null until the opt-in transcript source is enabled', () => {
  const engine = new Engine(0);
  engine.setTokensPerMinute(14_500);
  assert.equal(
    engine.snapshot(100).tokens_per_minute,
    null,
    'a token rate must not appear while the source is off',
  );

  engine.enableTranscriptSource(true);
  engine.setTokensPerMinute(14_500);
  assert.equal(engine.snapshot(200).tokens_per_minute, 14_500);
  assert.equal(engine.snapshot(200).sources.transcript, true);

  engine.enableTranscriptSource(false);
  assert.equal(engine.snapshot(300).tokens_per_minute, null, 'disabling must clear it');
});

test('activity rates are measured over the rolling window, then expire', () => {
  const engine = new Engine(0);
  for (let i = 0; i < 12; i += 1) {
    engine.ingest(event('BASH_STARTED', 1_000 + i * 100, { tool: 'bash' }));
  }
  const inWindow = engine.snapshot(5_000);
  assert.equal(inWindow.estimated_activity_rate, 12);
  assert.equal(inWindow.tool_calls_per_minute, 12);

  const expired = engine.snapshot(5_000 + engine.config.rateWindowMs + 1_000);
  assert.equal(expired.estimated_activity_rate, 0, 'the window must expire, not accumulate');
});

test('dropped lines are counted, not hidden', () => {
  const engine = new Engine(0);
  engine.noteDrop(3);
  assert.equal(engine.snapshot(0).debug.events_dropped, 3);
});
