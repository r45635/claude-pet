import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { resolveState, toVisualState, type StateInputs } from '../src/state.ts';

const C = DEFAULT_CONFIG;
const NOW = 1_000_000;

function inputs(overrides: Partial<StateInputs> = {}): StateInputs {
  return {
    nowMs: NOW,
    load: 10,
    lastActivityMs: NOW - 500,
    turnActive: true,
    permissionPending: false,
    lastErrorMs: 0,
    lastDoneMs: 0,
    lastIdleSignalMs: 0,
    dominant: null,
    dominantAtMs: 0,
    ...overrides,
  };
}

test('a fresh engine with no events at all is IDLE', () => {
  assert.equal(
    resolveState(inputs({ lastActivityMs: 0, turnActive: false }), C),
    'IDLE',
  );
});

test('ERROR outranks everything, including a token storm', () => {
  const state = resolveState(
    inputs({ lastErrorMs: NOW - 1_000, load: 99, permissionPending: true }),
    C,
  );
  assert.equal(state, 'ERROR');
});

test('ERROR expires after its sticky window instead of latching forever', () => {
  const state = resolveState(
    inputs({ lastErrorMs: NOW - (C.errorStickyMs + 1), load: 99 }),
    C,
  );
  assert.equal(state, 'HIGH_LOAD');
});

test('WAITING outranks activity — a blocked session must not look busy', () => {
  assert.equal(
    resolveState(inputs({ permissionPending: true, load: 99, dominant: 'write', dominantAtMs: NOW }), C),
    'WAITING',
  );
});

test('DONE is held briefly after a turn, then gives way', () => {
  assert.equal(
    resolveState(inputs({ turnActive: false, lastDoneMs: NOW - 500 }), C),
    'DONE',
  );
  assert.equal(
    resolveState(
      inputs({ turnActive: false, lastDoneMs: NOW - (C.doneStickyMs + 1), lastActivityMs: NOW - 1_000 }),
      C,
    ),
    'IDLE',
    'once DONE expires with no turn running, the session is genuinely idle',
  );
});

test('DONE does not steal the display from a turn that is already running again', () => {
  assert.equal(
    resolveState(inputs({ turnActive: true, lastDoneMs: NOW - 100, load: 99 }), C),
    'HIGH_LOAD',
  );
});

test('a long silence with no turn running is IDLE', () => {
  assert.equal(
    resolveState(inputs({ turnActive: false, lastActivityMs: NOW - (C.idleAfterMs + 1) }), C),
    'IDLE',
  );
});

test('an explicit idle signal wins over a stale activity timestamp', () => {
  assert.equal(
    resolveState(
      inputs({ turnActive: false, lastActivityMs: NOW - 1_000, lastIdleSignalMs: NOW - 500 }),
      C,
    ),
    'IDLE',
  );
});

test('dominant activity maps to READING / CODING / TOOL_CALL', () => {
  assert.equal(resolveState(inputs({ dominant: 'read', dominantAtMs: NOW }), C), 'READING');
  assert.equal(resolveState(inputs({ dominant: 'write', dominantAtMs: NOW }), C), 'CODING');
  assert.equal(resolveState(inputs({ dominant: 'tool', dominantAtMs: NOW }), C), 'TOOL_CALL');
});

test('a stale dominant activity does not keep the creature reading forever', () => {
  assert.equal(
    resolveState(inputs({ dominant: 'read', dominantAtMs: NOW - (C.idleAfterMs + 1) }), C),
    'THINKING',
  );
});

test('a running turn with nothing observable in flight is THINKING', () => {
  assert.equal(resolveState(inputs({ turnActive: true, dominant: null }), C), 'THINKING');
});

test('HIGH_LOAD triggers exactly at the threshold', () => {
  const busy = { dominant: 'write' as const, dominantAtMs: NOW };
  assert.equal(resolveState(inputs({ ...busy, load: C.highLoadThreshold }), C), 'HIGH_LOAD');
  assert.equal(resolveState(inputs({ ...busy, load: C.highLoadThreshold - 1 }), C), 'CODING');
});

test('HIGH_LOAD has hysteresis: it holds until load falls below the exit threshold', () => {
  const busy = { dominant: 'write' as const, dominantAtMs: NOW };
  const exit = C.highLoadExitThreshold!;
  assert.ok(exit < C.highLoadThreshold);
  const between = { ...busy, load: exit + 1 };
  assert.equal(resolveState(inputs({ ...between, previous: 'HIGH_LOAD' }), C), 'HIGH_LOAD');
  assert.equal(resolveState(inputs({ ...between, previous: 'CODING' }), C), 'CODING');
  assert.equal(resolveState(inputs({ ...busy, load: exit - 1, previous: 'HIGH_LOAD' }), C), 'CODING');
});

test('all nine states collapse onto the four MVP visuals', () => {
  assert.equal(toVisualState('IDLE'), 'IDLE');
  assert.equal(toVisualState('ERROR'), 'ERROR');
  assert.equal(toVisualState('HIGH_LOAD'), 'HIGH_LOAD');
  for (const state of ['THINKING', 'READING', 'CODING', 'TOOL_CALL', 'WAITING', 'DONE'] as const) {
    assert.equal(toVisualState(state), 'ACTIVE', `${state} should render as ACTIVE`);
  }
});
