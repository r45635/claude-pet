import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, format, scriptOf, SILENCE_MS, type Facts, type Health } from '../src/doctor.ts';
import { HOOK_EVENTS, planInstall } from '../src/install.ts';

const BIN = '/Users/me/.claude-pet/app/hooks';
const HEALTH: Health = {
  events_seen: 120, events_dropped: 0, last_event_at: null, spool_offset: 1_000,
  sources: { hooks: true, statusline: true, transcript: false, otel: false },
  config_invalid: false, config_warnings: [], version: '0.4.0',
};

/** A machine where everything works; each test breaks one thing. */
function facts(over: Partial<Facts> = {}): Facts {
  return {
    nowMs: 1_000_000_000, version: '0.4.0', binDir: BIN, setupCommand: 'claude-pet setup', jq: true,
    settings: planInstall({}, BIN).settings, settingsFile: '/Users/me/.claude/settings.json',
    scriptExists: (p) => p.startsWith(BIN), daemonUrl: 'http://127.0.0.1:8787', health: HEALTH,
    spool: { size: 1_000, lastEventMs: 1_000_000_000 - 5_000 }, claudeRunning: true, widgetRunning: true,
    agents: [{ label: 'x.daemon', installed: true, loaded: true }, { label: 'x.widget', installed: true, loaded: true }],
    ...over,
  };
}
const byName = (f: Facts) => Object.fromEntries(diagnose(f).map((c) => [c.name, c]));
const bad = (f: Facts) => diagnose(f).filter((c) => c.status === 'warn' || c.status === 'fail');

test('doctor: a working install is all green', () => {
  assert.deepEqual(bad(facts()), []);
  assert.match(byName(facts()).hooks!.detail, new RegExp(`${HOOK_EVENTS.length}/${HOOK_EVENTS.length}`));
});

test('doctor: hooks missing, partial, broken or pointing at another copy', () => {
  assert.equal(byName(facts({ settings: {} })).hooks!.status, 'fail');
  assert.equal(byName(facts({ settings: null })).hooks!.status, 'fail');
  assert.equal(byName(facts({ settings: { error: 'Unexpected token' } })).hooks!.status, 'fail');

  const partial = planInstall({}, BIN).settings;
  delete partial.hooks!.PreToolUse;
  const p = byName(facts({ settings: partial })).hooks!;
  assert.equal(p.status, 'fail');
  assert.match(p.detail, /missing: PreToolUse/);

  const gone = planInstall({}, '/Users/me/old clone/bin').settings;
  const g = byName(facts({ settings: gone })).hooks!;
  assert.equal(g.status, 'fail', 'a hook whose script is gone silently does nothing');
  assert.match(g.detail, /old clone/);

  const other = planInstall({}, '/Users/me/Github/claude-pet/packages/collector/bin').settings;
  const o = byName(facts({ settings: other, scriptExists: () => true })).hooks!;
  assert.equal(o.status, 'warn', 'another copy still works: a warning, not a failure');

  const twice = planInstall({}, BIN).settings;
  twice.hooks!.Stop!.push(structuredClone(twice.hooks!.Stop![0]!));
  assert.match(byName(facts({ settings: twice })).hooks!.detail, /twice on Stop/);
});

test('doctor: a foreign status line is left alone, and said to cost the gauges', () => {
  const settings = { ...planInstall({}, BIN).settings, statusLine: { type: 'command', command: 'my-line.sh' } };
  const c = byName(facts({ settings }))['status line']!;
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /gauges stay offline/);
});

test('doctor: the daemon down, on another version, or with a broken config', () => {
  assert.equal(byName(facts({ health: { error: 'ECONNREFUSED' } })).daemon!.status, 'fail');
  assert.equal(byName(facts({ health: { ...HEALTH, version: '0.3.1' } })).daemon!.status, 'warn');
  assert.equal(byName(facts({ health: { ...HEALTH, config_invalid: true, config_warnings: ['not JSON'] } })).config!.status, 'fail');
});

test('doctor: Claude running with no recent hook event is the failure no status shows', () => {
  const now = 1_000_000_000;
  const stale = facts({ spool: { size: 1_000, lastEventMs: now - SILENCE_MS - 60_000 } });
  assert.equal(byName(stale).events!.status, 'warn');
  assert.equal(byName({ ...stale, claudeRunning: false }).events!.status, 'ok', 'no Claude running: silence is normal');
  assert.equal(byName(facts({ spool: null })).events!.status, 'fail');
  assert.equal(byName(facts({ spool: null, claudeRunning: false })).events!.status, 'info');
});

test('doctor: a reader stuck behind the spool, dropped lines, no widget', () => {
  assert.match(format(diagnose(facts({ spool: { size: 500_000, lastEventMs: 1_000_000_000 } }))), /KB behind the spool/);
  assert.ok(bad(facts({ health: { ...HEALTH, events_dropped: 3 } })).some((c) => /could not be read/.test(c.detail)));
  assert.equal(byName(facts({ widgetRunning: false })).widget!.status, 'warn');
});

test('doctor: scriptOf reads back what install writes, quotes and spaces included', () => {
  assert.equal(scriptOf('sh "/Users/me/my \\"pet\\"/hook.sh"'), '/Users/me/my "pet"/hook.sh');
  assert.equal(scriptOf('bash ~/x.sh'), null);
});
