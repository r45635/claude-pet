import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifestName, manifestText } from '../src/manifest.ts';
import { compareTags, freshUpdateState, installStandalone, latestTagFromHeaders, parseTag, STANDALONE_ARCHIVE, type FetchAsset } from '../src/update.ts';

test('update: the latest tag is read from the redirect, not guessed', () => {
  const headers = 'HTTP/2 302\r\nserver: GitHub.com\r\nlocation: https://github.com/r45635/claude-pet/releases/tag/v0.4.0\r\n';
  assert.equal(latestTagFromHeaders(headers), 'v0.4.0');
  assert.equal(latestTagFromHeaders('HTTP/2 302\r\nLocation: /r45635/claude-pet/releases/tag/v1.0.0-rc.1\r\n'), 'v1.0.0-rc.1');
  assert.equal(latestTagFromHeaders('HTTP/2 200\r\nserver: GitHub.com\r\n'), null, 'no redirect, no claim');
  assert.equal(latestTagFromHeaders('location: https://evil.example/releases\r\n'), null);
  assert.equal(latestTagFromHeaders('location: https://github.com/r45635/claude-pet/releases/tag/v%E0%A4%A\r\n'), null,
               'a malformed escape is no tag, not an exception');
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

/**
 * A release folder: the archive, its signed manifest (manifest.ts), and the legacy .sha256 +
 * .sha256.sig that only installs before v0.5.5 read. `manifestTag` replays a genuine manifest
 * under another tag; `link` puts a symlink in the archive.
 */
function fakeRelease(opts: { version: string; signed?: boolean; badSig?: boolean; tamper?: boolean; drop?: string;
                             manifestTag?: string; link?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-rel-'));
  const src = join(dir, 'src', 'claude-pet');
  mkdirSync(join(src, 'hooks'), { recursive: true });
  for (const f of ['claude-pet', 'claude-pet-widget', 'hooks/claude-pet-hook.sh', 'hooks/claude-pet-statusline.sh']) {
    if (f !== opts.drop) writeFileSync(join(src, f), `${opts.version} ${f}\n`);
  }
  if (opts.link) symlinkSync('/etc/hosts', join(src, 'hooks', 'hosts'));
  const archive = join(dir, STANDALONE_ARCHIVE);
  execFileSync('tar', ['-czf', archive, '-C', join(dir, 'src'), 'claude-pet']);
  const bytes = readFileSync(archive);
  const sha256 = createHash('sha256').update(opts.tamper ? Buffer.from('x') : bytes).digest('hex');
  const manifest = manifestText({ tag: opts.manifestTag ?? opts.version, file: STANDALONE_ARCHIVE, sha256 });
  writeFileSync(manifestName(archive), manifest);
  writeFileSync(`${archive}.sha256`, `${sha256}  ${STANDALONE_ARCHIVE}\n`);
  const sig = (text: string) => sign(null, Buffer.from(text), KEYS.privateKey).toString('base64');
  writeFileSync(`${archive}.sha256.sig`, sig(`${sha256}  ${STANDALONE_ARCHIVE}\n`));
  if (opts.signed !== false) writeFileSync(`${manifestName(archive)}.sig`, sig(opts.badSig ? 'something else' : manifest));
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

const current = 'v0.3.0';

test('install: a signed release swaps in, the previous version is kept as app.old', async () => {
  const { root, app } = installedApp();
  const r = await installStandalone('v0.4.0', { root, app, current, pubkey: PUB, fetchAsset: fakeRelease({ version: 'v0.4.0' }) });
  assert.deepEqual(r, { ok: true });
  assert.equal(readFileSync(join(app, 'claude-pet'), 'utf8'), 'v0.4.0 claude-pet\n');
  assert.equal(readFileSync(join(`${app}.old`, 'claude-pet'), 'utf8'), 'v0.3.0 claude-pet\n');
});

test('install: whatever is wrong, app is left untouched', async () => {
  for (const [opts, why] of [
    [{ version: 'v0.4.0', tamper: true }, /SHA-256/],
    [{ version: 'v0.4.0', badSig: true }, /signature does not verify/],
    [{ version: 'v0.4.0', drop: 'claude-pet-widget' }, /incomplete/],
    // No signed manifest (a release before v0.5.5, or one stripped of it): no install, no "anyway".
    [{ version: 'v0.4.0', signed: false }, /signed manifest/],
    // A genuine older release re-published as v0.4.0: its manifest still names the old tag.
    [{ version: 'v0.4.0', manifestTag: 'v0.3.5' }, /for v0\.3\.5, not v0\.4\.0/],
    [{ version: 'v0.4.0', link: true }, /links or special files/],
  ] as const) {
    const { root, app } = installedApp();
    const r = await installStandalone('v0.4.0', { root, app, current, pubkey: PUB, fetchAsset: fakeRelease(opts) });
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match((r as { error: string }).error, why);
    assert.equal(readFileSync(join(app, 'claude-pet'), 'utf8'), 'v0.3.0 claude-pet\n', 'still the working version');
    assert.equal(existsSync(`${app}.old`), false);
  }
});

test('install: an older or the same version is a downgrade, refused before any download', async () => {
  let fetched = false;
  const fetchAsset: FetchAsset = async () => { fetched = true; throw new Error('should not fetch'); };
  for (const tag of ['v0.3.0', 'v0.2.9', 'v0.3.0-rc.1']) {
    const { root, app } = installedApp();
    const r = await installStandalone(tag, { root, app, current, pubkey: PUB, fetchAsset });
    assert.match((r as { error: string }).error, /not newer than the installed v0\.3\.0/);
  }
  assert.equal(fetched, false);
});

test('install: a release signed by another key is refused', async () => {
  const { root, app } = installedApp();
  const r = await installStandalone('v0.4.0', { root, app, current, fetchAsset: fakeRelease({ version: 'v0.4.0' }) }); // pinned key
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /signature/);
});
