import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_REPO, VERSION } from '../src/entry.ts';
import { assetName, checksumMatches, downloadedPath, releaseUrl, TARGET } from '../src/widget.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');

test('widget: the installer asks for the asset the workflow publishes', () => {
  // release.yml names it claude-pet-widget-$tag-$TARGET.tar.gz with TARGET in env.
  assert.match(WORKFLOW, /asset=claude-pet-widget-\$tag-\$TARGET\.tar\.gz/);
  assert.match(WORKFLOW, new RegExp(`TARGET: ${TARGET}\\n`));
  assert.equal(assetName('v1.2.3'), `claude-pet-widget-v1.2.3-${TARGET}.tar.gz`);
});

test('widget: one version, one tag, everywhere', () => {
  const conf = JSON.parse(readFileSync(join(REPO, 'apps', 'widget', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const cargo = readFileSync(join(REPO, 'apps', 'widget', 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.equal(conf.version, VERSION);
  assert.match(cargo, new RegExp(`^version = "${VERSION.replace(/\./g, '\\.')}"$`, 'm'));
});

test('widget: release URL and download path', () => {
  assert.match(GITHUB_REPO, /^[\w.-]+\/[\w.-]+$/);
  assert.equal(releaseUrl('v0.1.0', 'x.tar.gz', 'o/r'), 'https://github.com/o/r/releases/download/v0.1.0/x.tar.gz');
  assert.equal(downloadedPath('v0.1.0', '/h/.claude-pet'), '/h/.claude-pet/bin/v0.1.0/claude-pet-widget');
});

test('widget: the archive must match its published SHA-256', () => {
  const archive = Buffer.from('not really a tarball');
  const hex = createHash('sha256').update(archive).digest('hex');
  assert.equal(checksumMatches(archive, `${hex}  claude-pet-widget.tar.gz\n`), true);
  assert.equal(checksumMatches(archive, hex.toUpperCase()), true);
  assert.equal(checksumMatches(Buffer.from('tampered'), `${hex}  x`), false);
  assert.equal(checksumMatches(archive, ''), false);
  assert.equal(checksumMatches(archive, '<html>Not Found</html>'), false);
});
