import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepDownloads } from '../src/catalog.ts';
import { capLog } from '../src/spool.ts';
import { pruneWidgets } from '../src/widget.ts';

const home = () => mkdtempSync(join(tmpdir(), 'claude-pet-hk-'));

test('housekeeping: only the widget being launched survives an update', () => {
  const root = home();
  for (const d of ['v0.1.1', 'v0.2.0', 'v0.3.0', 'v0.3.1', 'v0.4.0-rc.1', '.fetch-abc', 'notes']) {
    mkdirSync(join(root, 'bin', d), { recursive: true });
  }
  assert.deepEqual(pruneWidgets('v0.3.1', root).sort(), ['.fetch-abc', 'v0.1.1', 'v0.2.0', 'v0.3.0', 'v0.4.0-rc.1']);
  assert.deepEqual(readdirSync(join(root, 'bin')).sort(), ['notes', 'v0.3.1'], 'unknown folders are not ours to delete');
  assert.deepEqual(pruneWidgets(null, root), ['v0.3.1'], 'a local build runs: every download is obsolete');
  assert.deepEqual(pruneWidgets('v1.0.0', home()), [], 'no bin folder: nothing to do');
});

test('housekeeping: a launchd log stays under twice its cap, newest lines kept', () => {
  const dir = home();
  const log = join(dir, 'daemon.log');
  writeFileSync(log, 'x'.repeat(900));
  assert.equal(capLog(log, 1_000), false, 'under the cap: untouched');
  appendFileSync(log, 'y'.repeat(200));
  assert.equal(capLog(log, 1_000), true);
  assert.equal(statSync(log).size, 0, 'truncated in place (launchd keeps appending to it)');
  assert.equal(readFileSync(`${log}.1`, 'utf8').length, 1_100);
  appendFileSync(log, 'z'.repeat(1_200));
  capLog(log, 1_000);
  assert.match(readFileSync(`${log}.1`, 'utf8'), /^z+$/, 'one previous log only, the newest');
  assert.equal(capLog(join(dir, 'missing.log')), false);
});

test('housekeeping: crash leftovers are swept once an hour old, fresh ones left alone', () => {
  const root = home();
  const old = Date.now() / 1000 - 7_200;
  const make = (p: string, aged: boolean) => {
    mkdirSync(p, { recursive: true });
    if (aged) utimesSync(p, old, old);
  };
  make(join(root, '.avatar-dl-old'), true);
  make(join(root, '.update-old'), true);
  make(join(root, '.update-now'), false);
  make(join(root, 'avatars', '.import-ghost-123'), true);
  make(join(root, 'avatars', '.import-cli-9-x'), true);
  make(join(root, 'avatars', 'ghost'), true);
  assert.deepEqual(sweepDownloads(root).sort(), ['.avatar-dl-old', '.import-cli-9-x', '.import-ghost-123', '.update-old']);
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('.')), ['.update-now'], 'an install in progress is not swept');
  assert.deepEqual(readdirSync(join(root, 'avatars')), ['ghost'], 'installed avatars are never touched');
});
