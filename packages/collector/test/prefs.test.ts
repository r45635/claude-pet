import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeConfig, DEFAULT_CONFIG, TEMPERAMENTS } from '@claude-pet/core';
import { applyPatch, DEFAULT_PREFS, prefsOf, validatePatch } from '../src/prefs.ts';

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
  assert.deepEqual(prefsOf(next), { temperament: 'nervous', size: 'small', showSessions: true, paused: true });
});

test('temperament: preset applies, and an explicit override still wins over it', () => {
  const zen = mergeConfig({ temperament: 'zen' });
  assert.equal(zen.highLoadThreshold, TEMPERAMENTS.zen.highLoadThreshold);
  assert.equal(zen.channels.tool.k, DEFAULT_CONFIG.channels.tool.k, 'untouched knobs keep defaults');
  const tuned = mergeConfig({ temperament: 'zen', highLoadThreshold: 90 });
  assert.equal(tuned.highLoadThreshold, 90);
  assert.equal((tuned as Record<string, unknown>).ui, undefined, 'ui prefs never leak into engine config');
});
