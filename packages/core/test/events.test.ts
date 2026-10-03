import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePetEvent, parseSpoolLine, serializePetEvent, SCHEMA_VERSION } from '../src/events.ts';

const ts = '2026-10-03T15:40:00.000-04:00';
const base = { v: SCHEMA_VERSION, ts, type: 'TOOL_STARTED' };

test('parses a minimal valid event and derives tsMs', () => {
  const event = parsePetEvent(base);
  assert.ok(event);
  assert.equal(event.type, 'TOOL_STARTED');
  assert.equal(event.n, 1);
  assert.equal(event.tsMs, Date.parse(ts));
});

test('drops instead of throwing on anything it does not understand', () => {
  for (const bad of [
    null,
    undefined,
    42,
    'TOOL_STARTED',
    {},
    { ...base, v: 2 },
    { ...base, v: undefined },
    { ...base, type: 'NOT_A_TYPE' },
    { ...base, ts: 'not-a-date' },
    { ...base, ts: undefined },
    { v: SCHEMA_VERSION, ts, type: 'METER_SAMPLE' }, // METER_SAMPLE without a meter
  ]) {
    assert.equal(parsePetEvent(bad), null, `should have dropped ${JSON.stringify(bad)}`);
  }
});

test('malformed JSON yields null, never a throw', () => {
  assert.equal(parseSpoolLine('{not json'), null);
  assert.equal(parseSpoolLine(''), null);
  assert.equal(parseSpoolLine('   '), null);
  assert.equal(parseSpoolLine('null'), null);
});

test('privacy: unknown keys cannot survive the parse', () => {
  const event = parsePetEvent({
    ...base,
    prompt: 'CANARY the secret prompt',
    tool_input: { command: 'CANARY rm -rf /', file_path: '/CANARY/secret.ts' },
    tool_result: 'CANARY output',
    cwd: '/Users/someone/CANARY-client-repo',
    file_content: 'CANARY',
  });
  assert.ok(event);
  assert.ok(
    !JSON.stringify(event).includes('CANARY'),
    'a non-allow-listed field reached the engine',
  );
  assert.deepEqual(
    Object.keys(event).sort(),
    ['n', 'ts', 'tsMs', 'type', 'v'],
    'only allow-listed keys should be present',
  );
});

test('an unrecognised tool collapses to `other`, never its own name', () => {
  const event = parsePetEvent({ ...base, tool: 'mcp__acme_internal__get_customer_pii' });
  assert.ok(event);
  assert.equal(event.tool, 'other');
});

test('known tool classes pass through', () => {
  for (const tool of ['bash', 'read', 'write', 'edit', 'mcp']) {
    assert.equal(parsePetEvent({ ...base, tool })?.tool, tool);
  }
});

test('n is clamped to a sane positive integer', () => {
  assert.equal(parsePetEvent({ ...base, n: 0 })?.n, 1);
  assert.equal(parsePetEvent({ ...base, n: -5 })?.n, 1);
  assert.equal(parsePetEvent({ ...base, n: 3.9 })?.n, 3);
  assert.equal(parsePetEvent({ ...base, n: 1e9 })?.n, 1000);
});

test('METER_SAMPLE keeps nulls as nulls instead of inventing zeros', () => {
  const event = parsePetEvent({
    v: 1,
    ts,
    type: 'METER_SAMPLE',
    meter: { context_used_pct: null, in_tokens: 500, effort: 'high' },
  });
  assert.ok(event?.meter);
  assert.equal(event.meter.context_used_pct, null);
  assert.equal(event.meter.in_tokens, 500);
  assert.equal(event.meter.cost_usd, null, 'absent field must be null, not 0');
  assert.equal(event.meter.effort, 'high');
});

test('serialize -> parse round-trips and omits derived fields', () => {
  const event = parsePetEvent({ ...base, tool: 'bash', n: 3, ms: 120 });
  assert.ok(event);
  const line = serializePetEvent(event);
  assert.ok(!line.includes('tsMs'), 'tsMs is derived and must not be written');
  const back = parseSpoolLine(line);
  assert.deepEqual(back, event);
});
