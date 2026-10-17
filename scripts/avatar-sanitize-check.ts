#!/usr/bin/env node
/**
 * Runs apps/widget/web/avatar-test.html — poisoned SVG avatars through the page's
 * sanitizer — in headless Chrome, because the sanitizer needs a real DOMParser.
 * Not part of `npm test` (it needs Chrome); run it after touching web/avatar.js:
 *
 *   npm run test:avatar-sanitizer
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME)) {
  process.stderr.write(`Chrome not found at ${CHROME} (set CHROME=…)\n`);
  process.exit(2);
}
const page = `file://${join(import.meta.dirname, '..', 'apps', 'widget', 'web', 'avatar-test.html')}`;
const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files',
  '--virtual-time-budget=5000', '--dump-dom', page], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const title = /<title>([^<]*)<\/title>/.exec(dom)?.[1] ?? 'no verdict';
const details = /<pre id="out">([^<]*)<\/pre>/.exec(dom)?.[1] ?? '';
process.stdout.write(`${title}\n${title.startsWith('PASS') ? '' : `${details}\n`}`);
process.exitCode = title.startsWith('PASS') ? 0 : 1;
