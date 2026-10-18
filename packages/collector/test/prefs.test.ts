import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeConfig, DEFAULT_CONFIG, TEMPERAMENTS } from '@claude-pet/core';
import {
  applyPatch, ConfigFileError, DEFAULT_PREFS, prefsOf, readUserFile, sanitizeEngine, shownPx, SIZE_PX, SPECS,
  validatePatch,
} from '../src/prefs.ts';
import { agents, plist, petEnv } from '../src/autostart.ts';
import { launchctlArgs } from '../src/login.ts';

test('prefs: an empty or foreign file yields the defaults', () => {
  assert.deepEqual(prefsOf({}), DEFAULT_PREFS);
  assert.deepEqual(prefsOf({ temperament: 'furious', ui: { size: 'huge', paused: 'yes', locale: 'xx', opacity: 7 } }), DEFAULT_PREFS);
});

test('prefs: safe defaults — chat off, nothing read, follows the system', () => {
  assert.equal(DEFAULT_PREFS.chatEnabled, false, 'the chat is a full agent: off until turned on');
  assert.equal(DEFAULT_PREFS.readTranscripts, false);
  assert.equal(DEFAULT_PREFS.locale, 'auto');
  assert.equal(DEFAULT_PREFS.theme, 'system');
  assert.equal(DEFAULT_PREFS.reduceMotion, 'system');
  assert.equal(DEFAULT_PREFS.sizePx, 150);
});

test('schema: every setting is documented, typed and has a valid default', () => {
  for (const spec of SPECS) {
    assert.ok(spec.doc.length > 10, spec.key);
    if (spec.default !== null) assert.ok('error' in validatePatch({ [spec.key]: spec.default }) === false, `${spec.key} default`);
  }
});

test('prefs: a patch is validated key by key, anything else is refused', () => {
  assert.deepEqual(validatePatch({ temperament: 'zen', size: 'large' }), { temperament: 'zen', nominalPx: SIZE_PX.large });
  assert.ok('error' in validatePatch({ highLoadThreshold: 1 }), 'engine knobs are not menu patches');
  assert.ok('error' in validatePatch({ temperament: 'furious' }));
  assert.ok('error' in validatePatch({ opacity: 0.1 }), 'below range');
  assert.ok('error' in validatePatch({ locale: 'de' }));
  assert.ok('error' in validatePatch([]));
  assert.deepEqual(validatePatch({ zoom: 1.234 }), { zoom: 1.2 }, 'numbers snap to their step');
});

test('prefs: applying a patch keeps hand-tuned overrides and other prefs untouched', () => {
  const user = { smoothing: { releaseMs: 12_000 }, ui: { size: { nominalPx: 110 }, locale: 'fr' } };
  const next = applyPatch(user, validatePatch({ temperament: 'nervous', paused: true }) as never);
  assert.deepEqual(next.smoothing, { releaseMs: 12_000 });
  const p = prefsOf(next);
  assert.equal(p.temperament, 'nervous');
  assert.equal(p.paused, true);
  assert.equal(p.locale, 'fr');
  assert.equal(p.nominalPx, 110);
  assert.equal(p.stormThreshold, TEMPERAMENTS.nervous.highLoadThreshold);
  assert.equal(user.ui.locale, 'fr', 'the input is not mutated');
});

test('size: shown = nominal × zoom, kept between min and max', () => {
  assert.equal(shownPx(150, 1, 80, 300), 150);
  assert.equal(shownPx(150, 1.5, 80, 300), 225);
  assert.equal(shownPx(150, 2, 80, 250), 250, 'capped by max');
  assert.equal(shownPx(150, 0.5, 100, 300), 100, 'floored by min');
  assert.equal(shownPx(150, 1, 300, 80), 150, 'min and max in either order');
  const zoomed = applyPatch({}, validatePatch({ nominalPx: 200, zoom: 1.5, maxPx: 260 }) as never);
  assert.deepEqual(zoomed.ui, { size: { nominalPx: 200, zoom: 1.5, maxPx: 260 } });
  assert.equal(prefsOf(zoomed).sizePx, 260);
  assert.equal(prefsOf(zoomed).size, 'custom');
});

test('size: older files and the v0.2 slider still work, and are converted on the next write', () => {
  assert.equal(prefsOf({ ui: { size: 'large' } }).nominalPx, SIZE_PX.large);
  assert.equal(prefsOf({ ui: { sizePx: 180 } }).nominalPx, 180);
  assert.equal(prefsOf({ ui: { size: 'large' } }).size, 'large', 'the menu still checks the preset');
  assert.deepEqual(validatePatch({ sizePx: 180 }), { nominalPx: 180 });
  const converted = applyPatch({ ui: { size: 'large', sizePx: 999, paused: true } }, validatePatch({ size: 'small' }) as never);
  assert.deepEqual(converted.ui, { paused: true, size: { nominalPx: SIZE_PX.small } });
  const reset = applyPatch(converted, validatePatch({ nominalPx: null }) as never);
  assert.deepEqual(reset.ui, { paused: true }, 'resetting removes the emptied containers');
  assert.equal(prefsOf(reset).sizePx, 150);
});

test('chat: on/off is a boolean pref; the default is off', () => {
  assert.ok('error' in validatePatch({ chatEnabled: 'yes' }));
  const on = applyPatch({}, validatePatch({ chatEnabled: true }) as never);
  assert.deepEqual(on.ui, { chat: { enabled: true } });
  assert.equal(prefsOf(on).chatEnabled, true);
  const spec = SPECS.find((s) => s.key === 'chatEnabled')!;
  assert.equal(spec.nativeOnlyTrue, true, 'the widget lets only its native menu turn it on');
});

test('prefs: the avatar is an id, never a path', () => {
  assert.deepEqual(validatePatch({ avatar: 'ghost' }), { avatar: 'ghost' });
  for (const bad of ['../x', 'Ghost', '', 'a/b', 'x'.repeat(41)]) {
    assert.ok('error' in validatePatch({ avatar: bad }), bad);
  }
  assert.equal(prefsOf({ ui: { avatar: '../../etc' } }).avatar, 'classic');
});

test('temperament: preset applies, and an explicit override still wins over it', () => {
  const zen = mergeConfig({ temperament: 'zen' });
  assert.equal(zen.highLoadThreshold, TEMPERAMENTS.zen.highLoadThreshold);
  assert.equal(zen.channels.tool.k, DEFAULT_CONFIG.channels.tool.k, 'untouched knobs keep defaults');
  const tuned = mergeConfig({ temperament: 'zen', highLoadThreshold: 90 });
  assert.equal(tuned.highLoadThreshold, 90);
  assert.equal((tuned as Record<string, unknown>).ui, undefined, 'ui prefs never leak into engine config');
});

test('settings panel: the storm threshold is an engine override, and null resets it', () => {
  assert.ok('error' in validatePatch({ stormThreshold: 12 }), 'below range');
  assert.ok('error' in validatePatch({ stormThreshold: 80.5 }), 'whole numbers only');
  assert.ok('error' in validatePatch({ stormThreshold: '80' }));
  const set = applyPatch({ temperament: 'zen' }, validatePatch({ stormThreshold: 60 }) as never);
  assert.equal(set.highLoadThreshold, 60);
  assert.equal(set.highLoadExitThreshold, 50, 'the storm ends 10 points lower');
  assert.equal(mergeConfig(set).highLoadThreshold, 60, 'it wins over the temperament');
  assert.equal(prefsOf(set).stormThreshold, 60);
  const reset = applyPatch(set, validatePatch({ stormThreshold: null }) as never);
  assert.equal(prefsOf(reset).stormThreshold, TEMPERAMENTS.zen.highLoadThreshold, 'back to the preset');
  assert.equal(reset.highLoadExitThreshold, undefined);
});

test('settings panel: the minimum time per state is stored in ms, shown in seconds', () => {
  assert.ok('error' in validatePatch({ minStateSeconds: -1 }));
  assert.ok('error' in validatePatch({ minStateSeconds: 31 }));
  const set = applyPatch({}, validatePatch({ minStateSeconds: 4.5 }) as never);
  assert.equal(set.minStateMs, 4_500);
  assert.equal(prefsOf(set).minStateSeconds, 4.5);
  assert.equal(prefsOf(applyPatch(set, { minStateSeconds: null })).minStateSeconds, DEFAULT_CONFIG.minStateMs / 1000);
});

test('engine overrides: wrong types, out-of-range values and unknown keys are ignored and reported', () => {
  const { user, warnings } = sanitizeEngine({
    ui: { locale: 'fr' },
    smoothing: { releaseMs: 9_000, attackMs: -5 },
    highLoadThreshold: 'eighty',
    channels: { tool: { k: 5, nope: 1 } },
    typo: 1,
  });
  assert.deepEqual(user, { ui: { locale: 'fr' }, smoothing: { releaseMs: 9_000 }, channels: { tool: { k: 5 } } });
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.match(warnings.join('\n'), /smoothing\.attackMs: -5 is outside/);
  assert.match(warnings.join('\n'), /typo: unknown key/);
});

test('config file: missing is empty, unreadable throws — it must never be written over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-config-'));
  assert.deepEqual(readUserFile(join(dir, 'none.json')), {});
  const bad = join(dir, 'config.json');
  writeFileSync(bad, '{ "ui": { "locale": "fr", } }'); // a trailing comma, typical of a hand edit
  assert.throws(() => readUserFile(bad), ConfigFileError);
  writeFileSync(bad, '[1, 2]');
  assert.throws(() => readUserFile(bad), ConfigFileError);
  assert.equal(readFileSync(bad, 'utf8'), '[1, 2]');
});

test('autostart: the pet\'s variables reach launchd, the token never does', () => {
  const env = petEnv({ CLAUDE_PET_HOME: '/tmp/pet', CLAUDE_PET_TOKEN: 'secret', HOME: '/Users/x' });
  assert.deepEqual(env, { CLAUDE_PET_HOME: '/tmp/pet' });
  const text = plist({ ...agents()[0], env });
  assert.match(text, /<key>EnvironmentVariables<\/key>[\s\S]*CLAUDE_PET_HOME[\s\S]*\/tmp\/pet/);
  assert.ok(!text.includes('secret'));
  assert.ok(!plist({ ...agents()[0], env: {} }).includes('EnvironmentVariables'));
});

test('launch at login: launchctl enable/disable for both agents', () => {
  assert.deepEqual(launchctlArgs(false, 501), [
    ['disable', 'gui/501/dev.r45635.claude-pet.daemon'],
    ['disable', 'gui/501/dev.r45635.claude-pet.widget'],
  ]);
  assert.equal(launchctlArgs(true, 501)[0][0], 'enable');
});
