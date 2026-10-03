import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrCreateToken } from '../src/token.ts';
import { agents, plist } from '../src/autostart.ts';

const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'claude-pet-token-')), 'pet', 'token');

test('token: created once, then stable across calls (a restart keeps it)', () => {
  const file = fresh();
  const a = readOrCreateToken(file);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(readOrCreateToken(file), a);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('token: leaves no temp file behind', () => {
  const file = fresh();
  readOrCreateToken(file);
  assert.deepEqual(readdirSync(join(file, '..')), ['token']);
});

test('token: corrupt content is replaced, not trusted', () => {
  const file = fresh();
  readOrCreateToken(file);
  writeFileSync(file, 'not a token');
  assert.match(readOrCreateToken(file), /^[0-9a-f]{32}$/);
});

test('autostart: plist escapes paths and only restarts the widget after a crash', () => {
  const [daemon, widget] = agents();
  assert.match(plist(daemon), /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist(widget), /<key>SuccessfulExit<\/key><false\/>/);
  const odd = plist({ ...daemon, program: ['/a & b/<node>'] });
  assert.ok(odd.includes('/a &amp; b/&lt;node&gt;'));
});
