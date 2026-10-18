import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareTags, freshUpdateState, installStandalone, latestTagFromHeaders, parseTag, STANDALONE_ARCHIVE, type FetchAsset } from '../src/update.ts';

test('update: the latest tag is read from the redirect, not guessed', () => {
  const headers = 'HTTP/2 302\r\nserver: GitHub.com\r\nlocation: https://github.com/r45635/claude-pet/releases/tag/v0.4.0\r\n';
  assert.equal(latestTagFromHeaders(headers), 'v0.4.0');
  assert.equal(latestTagFromHeaders('HTTP/2 302\r\nLocation: /r45635/claude-pet/releases/tag/v1.0.0-rc.1\r\n'), 'v1.0.0-rc.1');
  assert.equal(latestTagFromHeaders('HTTP/2 200\r\nserver: GitHub.com\r\n'), null, 'no redirect, no claim');
  assert.equal(latestTagFromHeaders('location: https://evil.example/releases\r\n'), null);
});

test('update: tags compare as versions, a prerelease is older than its release', () => {
  assert.ok(compareTags('v0.4.0', 'v0.3.0') > 0);
  assert.ok(compareTags('v0.3.0', 'v0.3.1') < 0);
  assert.ok(compareTags('v1.0.0', 'v0.99.99') > 0);
  assert.equal(compareTags('v0.3.0', 'v0.3.0'), 0);
  assert.ok(compareTags('v0.3.0-rc.1', 'v0.3.0') < 0);
  assert.ok(compareTags('v0.3.0', 'v0.3.0-rc.1') > 0);
  assert.equal(compareTags('not-a-tag', 'v0.3.0'), 0, 'unparseable never claims an update');
  assert.equal(parseTag('v1.2'), null);
});

test('update: the fresh state says the layout and the local-build pin out loud', () => {
  const s = freshUpdateState('clone', true);
  assert.equal(s.available, false);
  assert.equal(s.layout, 'clone');
  assert.equal(s.pinnedLocalBuild, true);
  assert.equal(s.installing, false);
  assert.equal(s.error, null);
});

// ---- the standalone installer, offline: a fake signed release in a temp dir ----------------

const KEYS = generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** A release folder holding the archive, its .sha256 and (optionally) a .sig. */
function fakeRelease(opts: { version: string; signed?: boolean; badSig?: boolean; tamper?: boolean; drop?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-rel-'));
  const src = join(dir, 'src', 'claude-pet');
  mkdirSync(join(src, 'hooks'), { recursive: true });
  for (const f of ['claude-pet', 'claude-pet-widget', 'hooks/claude-pet-hook.sh', 'hooks/claude-pet-statusline.sh']) {
    if (f !== opts.drop) writeFileSync(join(src, f), `${opts.version} ${f}\n`);
  }
  const archive = join(dir, STANDALONE_ARCHIVE);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'src'), 'claude-pet']);
  const bytes = readFileSync(archive);
  const sha = `${createHash('sha256').update(opts.tamper ? Buffer.from('x') : bytes).digest('hex')}  ${STANDALONE_ARCHIVE}\n`;
  writeFileSync(`${archive}.sha256`, sha);
  if (opts.signed !== false) {
    const signed = opts.badSig ? Buffer.from('something else') : Buffer.from(sha);
    writeFileSync(`${archive}.sha256.sig`, sign(null, signed, KEYS.privateKey).toString('base64'));
  }
  const fetchAsset: FetchAsset = async (_tag, file, dest) => {
    const from = join(dir, file);
    if (!existsSync(from)) throw new Error('404');
    copyFileSync(from, dest);
  };
  return fetchAsset;
}

function installedApp(): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), 'claude-pet-home-'));
  const app = join(root, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'claude-pet'), 'v0.3.0 claude-pet\n');
  return { root, app };
}

test('install: a signed release swaps in, the previous version is kept as app.old', async () => {
  const { root, app } = installedApp();
  const r = await installStandalone('v0.4.0', { root, app, pubkey: PUB, fetchAsset: fakeRelease({ version: 'v0.4.0' }) });
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(join(app, 'claude-pet'), 'utf8'), 'v0.4.0 claude-pet\n');
  assert.equal(readFileSync(join(`${app}.old`, 'claude-pet'), 'utf8'), 'v0.3.0 claude-pet\n');
});

test('install: a tampered checksum, a bad signature or an incomplete archive leave app untouched', async () => {
  for (const [opts, why] of [
    [{ version: 'v0.4.0', tamper: true }, /SHA-256/],
    [{ version: 'v0.4.0', badSig: true }, /signature does not verify/],
    [{ version: 'v0.4.0', drop: 'claude-pet-widget' }, /incomplete/],
  ] as const) {
    const { root, app } = installedApp();
    const r = await installStandalone('v0.4.0', { root, app, pubkey: PUB, fetchAsset: fakeRelease(opts) });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, why);
    assert.equal(readFileSync(join(app, 'claude-pet'), 'utf8'), 'v0.3.0 claude-pet\n', 'still the working version');
    assert.equal(existsSync(`${app}.old`), false);
  }
});

test('install: an unsigned release refuses unless a human allowed it', async () => {
  const { root, app } = installedApp();
  const fetchAsset = fakeRelease({ version: 'v0.4.0', signed: false });
  const r = await installStandalone('v0.4.0', { root, app, pubkey: PUB, fetchAsset });
  assert.equal(r.ok, false);
  assert.equal((r as { unsigned?: true }).unsigned, true);
  assert.equal(readFileSync(join(app, 'claude-pet'), 'utf8'), 'v0.3.0 claude-pet\n');
  const forced = await installStandalone('v0.4.0', { root, app, pubkey: PUB, fetchAsset, allowUnsigned: true });
  assert.deepEqual(forced, { ok: true });
});

test('install: a release signed by another key is refused', async () => {
  const { root, app } = installedApp();
  const r = await installStandalone('v0.4.0', { root, app, fetchAsset: fakeRelease({ version: 'v0.4.0' }) }); // pinned key
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signature/);
});
