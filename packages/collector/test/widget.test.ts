import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_REPO, VERSION } from '../src/entry.ts';
import { assetName, checksumMatches, downloadedPath, releaseUrl, RELEASE_PUBKEY, TARGET, verifySignature } from '../src/widget.ts';

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

test('signing: only the key holder verifies; tampering and garbage refuse', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const data = Buffer.from('abc123  claude-pet-widget-v9.9.9.tar.gz\n');
  const sig = sign(null, data, privateKey).toString('base64');
  assert.equal(verifySignature(data, `${sig}\n`, pem), true);
  assert.equal(verifySignature(Buffer.from('tampered'), sig, pem), false);
  assert.equal(verifySignature(data, sig), false, 'a throwaway key must not verify against the pinned one');
  assert.equal(verifySignature(data, 'not base64 at all!', pem), false);
});

test('signing: the embedded pubkey is the committed pem, and tag builds sign', () => {
  const pem = readFileSync(join(REPO, 'packages', 'collector', 'src', 'release-pubkey.pem'), 'utf8');
  assert.equal(RELEASE_PUBKEY, pem);
  assert.match(WORKFLOW, /sign-release\.ts release\/\*\.sha256/);
  assert.match(WORKFLOW, /RELEASE_SIGNING_KEY secret is missing/);
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
