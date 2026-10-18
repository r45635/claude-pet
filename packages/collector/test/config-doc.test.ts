import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsTable } from '../src/config-doc.ts';

test('docs/CONFIG.md lists every setting as the schema has it (npm run docs:config)', () => {
  const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', 'docs', 'CONFIG.md'), 'utf8');
  assert.ok(doc.includes(settingsTable()), 'docs/CONFIG.md is stale: run npm run docs:config');
});
