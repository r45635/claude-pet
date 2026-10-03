import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
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
    net: false,
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

// Real sessions spend most of a turn in model reasoning that emits no hook at all.
// Measured before the work gauge: 11.7 min of real turns averaged load 10, never above 40.
test('a running turn with no events still reads as work, and calms once it ends', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0));
  let s = engine.snapshot(0);
  for (let now = 100; now <= 30_000; now += 100) s = engine.snapshot(now);
  assert.ok(s.load >= 45, `30 s into a silent turn the model is working, got load ${s.load}`);
  assert.equal(s.state, 'THINKING');

  engine.ingest(event('TURN_COMPLETED', 30_000));
  for (let now = 30_100; now <= 50_000; now += 100) s = engine.snapshot(now);
  assert.ok(s.load < 10, `20 s after Stop the creature should be calm, got ${s.load}`);
});

test('a turn whose Stop never came stops counting as work', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0));
  let s = engine.snapshot(0);
  for (let now = 1_000; now <= 200_000; now += 1_000) s = engine.snapshot(now);
  assert.equal(s.debug.channels.work, 0, 'no event for > staleAfterMs: the turn is not trusted');
});

test('waiting on a permission is not work', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0));
  engine.ingest(event('PERMISSION_WAITING', 1_000));
  let s = engine.snapshot(0);
  for (let now = 100; now <= 30_000; now += 100) s = engine.snapshot(now);
  assert.equal(s.state, 'WAITING');
  assert.ok(s.load < 10, `blocked on the user is not load, got ${s.load}`);
});

test('a Stop in one session does not end the turn of another', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'aaaa1111' }));
  engine.ingest(event('PROMPT_SUBMITTED', 1_000, { sid: 'bbbb2222' }));
  engine.ingest(event('TURN_COMPLETED', 5_000, { sid: 'bbbb2222' }));
  let s = engine.snapshot(0);
  for (let now = 100; now <= 20_000; now += 100) s = engine.snapshot(now);
  assert.equal(s.debug.turn_active, true, 'session aaaa1111 is still mid-turn');
  assert.ok(s.debug.channels.work > 30, `its work must still count, got ${s.debug.channels.work}`);
});

test('a granted permission clears WAITING as soon as the session acts again', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'aaaa1111' }));
  engine.ingest(event('PERMISSION_WAITING', 1_000, { sid: 'aaaa1111' }));
  assert.equal(engine.snapshot(2_000).state, 'WAITING');
  engine.ingest(event('BASH_FINISHED', 3_000, { sid: 'aaaa1111' }));
  assert.notEqual(engine.snapshot(3_100).state, 'WAITING');
});

test('sessions: one entry per live session, each with its own status', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'aaaa1111' }));
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'bbbb2222' }));
  engine.ingest(event('PERMISSION_WAITING', 1_000, { sid: 'bbbb2222' }));
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'cccc3333' }));
  engine.ingest(event('TURN_COMPLETED', 9_000, { sid: 'cccc3333' }));
  engine.ingest(event('SESSION_STARTED', 0, { sid: 'dddd4444' }));
  engine.ingest(event('SESSION_STARTED', 0, { sid: 'eeee5555' }));
  engine.ingest(event('SESSION_ENDED', 5_000, { sid: 'eeee5555' }));

  const byId = Object.fromEntries(engine.snapshot(10_000).sessions.map((s) => [s.id, s]));
  assert.equal(byId.aaaa1111?.status, 'working');
  assert.ok((byId.aaaa1111?.turn_ms ?? 0) >= 10_000);
  assert.equal(byId.bbbb2222?.status, 'waiting');
  assert.equal(byId.cccc3333?.status, 'done');
  assert.equal(byId.cccc3333?.turn_ms, null);
  assert.equal(byId.dddd4444?.status, 'idle');
  assert.equal(byId.eeee5555, undefined, 'an ended session is gone');

  const later = engine.snapshot(10_000 + DEFAULT_CONFIG.sessionTtlMs + 1_000).sessions;
  assert.deepEqual(later, [], 'silent sessions drop off after sessionTtlMs');
});

test('net: bytes arriving mean the model is generating, whatever tool ran before', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'aaaa1111', ppid: 4242 }));
  engine.ingest(event('BASH_STARTED', 1_000, { sid: 'aaaa1111' }));
  engine.ingest(event('BASH_FINISHED', 2_000, { sid: 'aaaa1111' }));
  assert.deepEqual(engine.sessionsToSample(), [{ sid: 'aaaa1111', ppid: 4242 }]);

  engine.ingestNet('aaaa1111', 6_000, 5_000, 8_000); // 1.2 KB/s: streaming
  let s = engine.snapshot(8_000);
  assert.equal(s.state, 'THINKING');
  assert.equal(s.sessions[0]?.status, 'thinking');
  assert.equal(s.sources.net, true);

  engine.ingestNet('aaaa1111', 500, 5_000, 13_000); // keepalive only: not generating
  s = engine.snapshot(13_000);
  assert.notEqual(s.state, 'THINKING');
  assert.equal(s.sessions[0]?.status, 'working');
});

test('net: a streaming session is not dropped by the silent-turn cutoff', () => {
  const engine = new Engine(0);
  engine.ingest(event('PROMPT_SUBMITTED', 0, { sid: 'aaaa1111', ppid: 4242 }));
  let s = engine.snapshot(0);
  for (let now = 5_000; now <= 300_000; now += 5_000) {
    engine.ingestNet('aaaa1111', 4_000, 5_000, now); // a five-minute think, no hook at all
    s = engine.snapshot(now);
  }
  assert.equal(s.state, 'THINKING');
  assert.ok(s.load >= 60, `a long measured think is real work, got ${s.load}`);
});
