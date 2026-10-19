import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otelEnv, otelEnvState, parseOtlpLogs, planOtelDisable, planOtelEnable } from '../src/otel.ts';

const s = (v: string) => ({ stringValue: v });
const i = (v: number | string) => ({ intValue: v });
/** Shaped like a real Claude Code batch (2.1.301), identifiers made up. */
function batch(records: { attributes: { key: string; value: unknown }[]; timeUnixNano?: string }[]) {
  return { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: s('claude-code') }] },
                            scopeLogs: [{ logRecords: records }] }] };
}
const common = [
  { key: 'user.email', value: s('someone@example.com') },
  { key: 'user.account_uuid', value: s('7f0e0c1a-account') },
  { key: 'organization.id', value: s('org-secret-id') },
  { key: 'session.id', value: s('a1b2c3d4-0000-4000-8000-000000000001') },
];
const apiRequest = (out: number | string, ts = '2026-10-19T10:50:54.207Z') => ({
  attributes: [...common, { key: 'event.name', value: s('api_request') }, { key: 'event.timestamp', value: s(ts) },
               { key: 'model', value: s('claude-haiku-5-5') }, { key: 'output_tokens', value: i(out) },
               { key: 'input_tokens', value: i(2) }, { key: 'cost_usd', value: { doubleValue: 0.0017 } },
               { key: 'request_id', value: s('req_000000000000000000fixture') }],
});
const userPrompt = { attributes: [...common, { key: 'event.name', value: s('user_prompt') },
                                  { key: 'prompt', value: s('my secret prompt') }, { key: 'prompt_length', value: s('16') }] };

test('otel: an api_request gives its session, time and output tokens — and nothing else', () => {
  const out = parseOtlpLogs(batch([userPrompt, apiRequest(14), apiRequest('2048', '2026-10-19T10:51:00.000Z')]));
  assert.deepEqual(out, [
    { sid: 'a1b2c3d4', atMs: Date.parse('2026-10-19T10:50:54.207Z'), outTokens: 14 },
    { sid: 'a1b2c3d4', atMs: Date.parse('2026-10-19T10:51:00.000Z'), outTokens: 2048 },
  ]);
  const text = JSON.stringify(out);
  for (const leak of ['someone@example.com', 'account', 'org-secret', 'secret prompt', 'haiku', 'req_', '4000-8000']) {
    assert.ok(!text.includes(leak), `${leak} must not cross the parser`);
  }
});

test('otel: the record time is the fallback, and anything malformed is skipped', () => {
  const noTs = { attributes: apiRequest(5).attributes.filter((a) => a.key !== 'event.timestamp'), timeUnixNano: '1792407054207000000' };
  assert.deepEqual(parseOtlpLogs(batch([noTs])), [{ sid: 'a1b2c3d4', atMs: 1792407054207, outTokens: 5 }]);
  const badSid = { attributes: apiRequest(5).attributes.map((a) => a.key === 'session.id' ? { key: a.key, value: s('../x') } : a) };
  const noTokens = { attributes: apiRequest(5).attributes.filter((a) => a.key !== 'output_tokens') };
  assert.deepEqual(parseOtlpLogs(batch([badSid, noTokens])), []);
  for (const junk of [null, 42, 'x', {}, { resourceLogs: 'no' }, { resourceLogs: [{ scopeLogs: [{ logRecords: [null, 3] }] }] }]) {
    assert.deepEqual(parseOtlpLogs(junk), [], JSON.stringify(junk));
  }
});

test('otel env: enable adds the logs signal only, and is idempotent', () => {
  const user = { model: 'opus', env: { OTEL_METRICS_EXPORTER: 'otlp', MY_VAR: '1' } };
  const plan = planOtelEnable(user, 8787);
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.settings.env, { ...user.env, ...otelEnv(8787) });
  assert.equal(plan.settings.model, 'opus');
  assert.deepEqual(user.env, { OTEL_METRICS_EXPORTER: 'otlp', MY_VAR: '1' }, 'input untouched');
  assert.deepEqual(planOtelEnable(plan.settings, 8787).changes, []);
  assert.equal(otelEnvState(plan.settings, 8787).state, 'on');
});

test('otel env: the user\'s own logs exporter is never overwritten', () => {
  const user = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'console' } };
  const plan = planOtelEnable(user, 8787);
  assert.match(plan.error ?? '', /OTEL_LOGS_EXPORTER/);
  assert.equal(plan.settings, user);
  assert.deepEqual(otelEnvState(user, 8787), { state: 'conflict', keys: ['OTEL_LOGS_EXPORTER'] });
  assert.equal(otelEnvState({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '0' } }, 8787).state, 'conflict', 'telemetry turned off on purpose');
});

test('otel env: a daemon on another port is repointed, not a conflict', () => {
  const on = planOtelEnable({}, 8787).settings;
  assert.deepEqual(otelEnvState(on, 9000), { state: 'partial', missing: ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] });
  assert.deepEqual(planOtelEnable(on, 9000).changes, ['~ env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']);
});

test('otel env: disable removes what enable added, and only that', () => {
  const plain = planOtelDisable(planOtelEnable({ model: 'opus' }, 8787).settings, 8787).settings;
  assert.deepEqual(plain, { model: 'opus' }, 'enable then disable is a no-op');
  const theirs = planOtelEnable({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp' } }, 8787).settings;
  assert.deepEqual(planOtelDisable(theirs, 8787).settings.env, { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp' },
    'telemetry stays on for the user\'s own metrics');
  assert.equal(otelEnvState({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp' } }, 8787).state, 'off');
});
