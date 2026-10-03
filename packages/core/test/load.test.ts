import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createLoadState, ingestLoad, tickLoad } from '../src/load.ts';
import { parsePetEvent, type PetEvent } from '../src/events.ts';

function event(type: string, atMs = 0): PetEvent {
  const parsed = parsePetEvent({ v: 1, ts: new Date(atMs).toISOString(), type });
  assert.ok(parsed, `fixture ${type} must parse`);
  return parsed;
}

test('an empty session scores zero with zero confidence', () => {
  const state = createLoadState(0);
  const result = tickLoad(state, 1_000, 0, DEFAULT_CONFIG);
  assert.equal(result.load, 0);
  assert.equal(result.confidence, 0);
});

test('load rises on events and decays back toward zero in silence', () => {
  const state = createLoadState(0);
  let now = 0;
  for (let i = 0; i < 40; i += 1) {
    ingestLoad(state, event('BASH_STARTED'), DEFAULT_CONFIG);
    ingestLoad(state, event('FILE_WRITE'), DEFAULT_CONFIG);
    now += 100;
    tickLoad(state, now, 0, DEFAULT_CONFIG);
  }
  const peak = tickLoad(state, now, 0, DEFAULT_CONFIG).load;
  assert.ok(peak > 70, `expected a busy burst to exceed 70, got ${peak}`);

  for (let i = 0; i < 300; i += 1) {
    now += 100;
    tickLoad(state, now, 0, DEFAULT_CONFIG);
  }
  const quiet = tickLoad(state, now, 0, DEFAULT_CONFIG).load;
  assert.ok(quiet < 10, `expected decay below 10 after 30s of silence, got ${quiet}`);
});

test('the saturating map never exceeds 100, even under absurd load', () => {
  const state = createLoadState(0);
  let now = 0;
  for (let i = 0; i < 500; i += 1) {
    ingestLoad(state, event('BASH_STARTED'), DEFAULT_CONFIG);
    now += 10;
  }
  const result = tickLoad(state, now, 0, DEFAULT_CONFIG);
  assert.ok(result.load <= 100, `load must be capped, got ${result.load}`);
  assert.ok(result.load > 0);
});

test('attack is faster than release — the creature startles, then calms slowly', () => {
  const up = createLoadState(0);
  let now = 0;
  // One identical burst, measured on the way up...
  for (let i = 0; i < 10; i += 1) {
    ingestLoad(up, event('BASH_STARTED'), DEFAULT_CONFIG);
  }
  now += 100;
  const afterOneTickUp = tickLoad(up, now, 0, DEFAULT_CONFIG).load;

  // ...and the same magnitude of change on the way down.
  const before = afterOneTickUp;
  now += 100;
  const afterOneTickDown = tickLoad(up, now, 0, DEFAULT_CONFIG).load;
  const riseStep = afterOneTickUp - 0;
  const fallStep = before - afterOneTickDown;
  assert.ok(
    riseStep > fallStep,
    `rise step (${riseStep}) should exceed fall step (${fallStep})`,
  );
});

test('a dead channel has its weight redistributed, not counted as zero', () => {
  // Only the `tool` channel ever fires. Its weight is 0.30; if dead channels counted as
  // zeros, a saturated tool channel would cap the blend near 30.
  const state = createLoadState(0);
  let now = 0;
  for (let i = 0; i < 60; i += 1) {
    ingestLoad(state, event('BASH_STARTED'), DEFAULT_CONFIG);
    now += 50;
    tickLoad(state, now, 0, DEFAULT_CONFIG);
  }
  const result = tickLoad(state, now, 0, DEFAULT_CONFIG);
  assert.ok(
    result.load > 60,
    `single live channel must still be able to score high, got ${result.load}`,
  );
  assert.equal(result.confidence, 0.3, 'confidence must report that only `tool` is live');
});

test('subagents contribute as a gauge, with no events at all', () => {
  const state = createLoadState(0);
  const quiet = tickLoad(state, 5_000, 0, DEFAULT_CONFIG);
  assert.equal(quiet.load, 0);

  const busy = createLoadState(0);
  let now = 0;
  for (let i = 0; i < 50; i += 1) {
    now += 100;
    tickLoad(busy, now, 3, DEFAULT_CONFIG);
  }
  const result = tickLoad(busy, now, 3, DEFAULT_CONFIG);
  assert.ok(result.load > 20, `three idle subagents should register, got ${result.load}`);
  assert.equal(result.confidence, 0.2);
});

test('smoothing is set in time, not per tick: 100 ms and 1 s ticks agree', () => {
  const run = (tickMs: number) => {
    const state = createLoadState(0);
    for (let i = 0; i < 10; i += 1) ingestLoad(state, event('BASH_STARTED'), DEFAULT_CONFIG);
    let load = 0;
    for (let now = tickMs; now <= 4_000; now += tickMs) {
      load = tickLoad(state, now, 0, DEFAULT_CONFIG).load;
    }
    return load;
  };
  const fine = run(100);
  const coarse = run(1_000);
  assert.ok(Math.abs(fine - coarse) <= 3, `100 ms tick gave ${fine}, 1 s tick gave ${coarse}`);
});

test('bursts land on top of turn work instead of being averaged against it', () => {
  const state = createLoadState(0);
  for (let i = 0; i < 4; i += 1) ingestLoad(state, event('BASH_STARTED'), DEFAULT_CONFIG);
  let withWork = 0;
  for (let now = 100; now <= 3_000; now += 100) {
    withWork = tickLoad(state, now, 0, DEFAULT_CONFIG, 60, true).load;
  }
  assert.ok(withWork > 75, `60 of work plus a burst should be a storm, got ${withWork}`);
});
