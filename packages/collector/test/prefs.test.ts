import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, DEFAULT_CONFIG, TEMPERAMENTS } from '@claude-pet/core';
import { applyPatch, DEFAULT_PREFS, prefsOf, SIZE_PX, validatePatch } from '../src/prefs.ts';

test('prefs: an empty or foreign file yields the defaults', () => {
  assert.deepEqual(prefsOf({}), DEFAULT_PREFS);
  assert.deepEqual(prefsOf({ temperament: 'furious', ui: { size: 'huge', paused: 'yes' } }), DEFAULT_PREFS);
});

test('prefs: a patch is validated key by key, anything else is refused', () => {
  assert.deepEqual(validatePatch({ temperament: 'zen', size: 'large' }), { temperament: 'zen', size: 'large' });
  assert.ok('error' in validatePatch({ highLoadThreshold: 1 }), 'engine knobs are not menu patches');
  assert.ok('error' in validatePatch({ temperament: 'furious' }));
  assert.ok('error' in validatePatch([]));
});

test('prefs: applying a patch keeps hand-tuned overrides untouched', () => {
  const user = { smoothing: { releaseMs: 12_000 }, ui: { size: 'small' } };
  const next = applyPatch(user, { temperament: 'nervous', paused: true });
  assert.deepEqual(next.smoothing, { releaseMs: 12_000 });
  assert.deepEqual(prefsOf(next), {
    temperament: 'nervous', chatModel: 'default', size: 'small', sizePx: 110, showSessions: true, paused: true,
    readTranscripts: false,
    stormThreshold: TEMPERAMENTS.nervous.highLoadThreshold, minStateSeconds: DEFAULT_CONFIG.minStateMs / 1000,
  });
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
});

test('settings panel: the minimum time per state is stored in ms, shown in seconds', () => {
  assert.ok('error' in validatePatch({ minStateSeconds: -1 }));
  assert.ok('error' in validatePatch({ minStateSeconds: 31 }));
  const set = applyPatch({}, validatePatch({ minStateSeconds: 4.5 }) as never);
  assert.equal(set.minStateMs, 4_500);
  assert.equal(prefsOf(set).minStateSeconds, 4.5);
  assert.equal(prefsOf(applyPatch(set, { minStateSeconds: null })).minStateSeconds, DEFAULT_CONFIG.minStateMs / 1000);
});

test('prefs: reading the conversation files is off unless turned on, and boolean only', () => {
  assert.equal(DEFAULT_PREFS.readTranscripts, false);
  assert.ok('error' in validatePatch({ readTranscripts: 'yes' }));
  const next = applyPatch({}, { readTranscripts: true });
  assert.equal(prefsOf(next).readTranscripts, true);
});

test('settings panel: the size slider sets any whole px in range, the menu presets stay shortcuts', () => {
  assert.ok('error' in validatePatch({ sizePx: 79 }));
  assert.ok('error' in validatePatch({ sizePx: 301 }));
  assert.ok('error' in validatePatch({ sizePx: 150.5 }));
  assert.ok('error' in validatePatch({ sizePx: '150' }));

  const custom = applyPatch({ ui: { size: 'large', paused: true } }, validatePatch({ sizePx: 180 }) as never);
  assert.deepEqual(custom.ui, { sizePx: 180, paused: true }, 'the slider replaces the preset');
  assert.equal(prefsOf(custom).sizePx, 180);
  assert.equal(prefsOf(custom).size, 'custom', 'no menu item is checked');

  const onPreset = applyPatch({}, validatePatch({ sizePx: SIZE_PX.large }) as never);
  assert.equal(prefsOf(onPreset).size, 'large', 'the slider on a preset value checks it in the menu');

  const menu = applyPatch(custom, validatePatch({ size: 'small' }) as never);
  assert.deepEqual(menu.ui, { size: 'small', paused: true }, 'a menu preset replaces the slider');
  assert.equal(prefsOf(menu).sizePx, SIZE_PX.small);

  const reset = applyPatch(custom, validatePatch({ sizePx: null }) as never);
  assert.equal(prefsOf(reset).sizePx, DEFAULT_PREFS.sizePx);
  assert.equal(prefsOf(reset).size, 'medium');
});

test('prefs: an older file with a size preset still reads, an out-of-range px falls back to it', () => {
  assert.equal(prefsOf({ ui: { size: 'large' } }).sizePx, SIZE_PX.large);
  assert.equal(prefsOf({ ui: { size: 'large', sizePx: 999 } }).sizePx, SIZE_PX.large);
});
