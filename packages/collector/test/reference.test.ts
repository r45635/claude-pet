import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfig } from '@claude-pet/core';
import { KEY_DOCS, referenceText } from '../src/reference.ts';

/** Strip `//` comment lines: what is left must be the effective config, as JSON. */
const strip = (text: string) => JSON.parse(text.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'));

test('reference: parses back to the effective config', () => {
  const config = mergeConfig({ temperament: 'zen', highLoadThreshold: 90 });
  const text = referenceText(config, 'zen');
  assert.deepEqual(strip(text), JSON.parse(JSON.stringify(config)));
  assert.match(text, /temperament "zen"/);
});

// Guard: a new engine knob cannot ship without being explained to the user.
test('reference: every engine key is documented (blocks may cover their children)', () => {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (KEY_DOCS[key]) continue;
    if (value && typeof value === 'object') {
      for (const child of Object.keys(value)) if (!KEY_DOCS[`${key}.${child}`]) missing.push(`${key}.${child}`);
    } else missing.push(key);
  }
  assert.deepEqual(missing, []);
});
