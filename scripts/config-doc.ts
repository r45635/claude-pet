#!/usr/bin/env node
/**
 * Regenerates the settings table in docs/CONFIG.md from settings-schema.json, between the
 * <!-- settings:start --> and <!-- settings:end --> markers, so the doc cannot drift from
 * the code (a test checks it is current).
 *
 *   npm run docs:config
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingsTable } from '../packages/collector/src/config-doc.ts';

const file = join(import.meta.dirname, '..', 'docs', 'CONFIG.md');
const doc = readFileSync(file, 'utf8');
const next = doc.replace(/(<!-- settings:start -->\n)[\s\S]*?(<!-- settings:end -->)/, `$1${settingsTable()}$2`);
if (next === doc) {
  process.stdout.write('docs/CONFIG.md is up to date\n');
} else {
  writeFileSync(file, next);
  process.stdout.write('docs/CONFIG.md updated\n');
}
