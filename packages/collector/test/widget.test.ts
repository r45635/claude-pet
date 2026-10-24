import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GITHUB_REPO, VERSION } from '../src/entry.ts';
import { CATALOG_PUBKEY } from '../src/catalog.ts';
import { catalogSignedBytes, manifestText, parseManifest } from '../src/manifest.ts';
import { assetName, downloadedPath, releaseProblem, releaseUrl, RELEASE_PUBKEY, TARGET, verifySignature } from '../src/widget.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');

test('widget: the installer asks for the asset the workflow publishes', () => {
  // release.yml names it claude-pet-widget-$tag-$TARGET.tar.gz with TARGET in env.
  assert.match(WORKFLOW, /asset="claude-pet-widget-\$TAG-\$TARGET\.tar\.gz"/);
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

test('signing: the embedded pubkeys are the committed pems, and only the tag job signs', () => {
  const pem = (name: string) => readFileSync(join(REPO, 'packages', 'collector', 'src', name), 'utf8');
  assert.equal(RELEASE_PUBKEY, pem('release-pubkey.pem'));
  assert.equal(CATALOG_PUBKEY, pem('catalog-pubkey.pem'));
  assert.notEqual(RELEASE_PUBKEY, CATALOG_PUBKEY, 'the catalog has its own key');
  assert.match(WORKFLOW, /sign-release\.ts --release "\$TAG" release\/\*\.tar\.gz/);
  assert.match(WORKFLOW, /RELEASE_SIGNING_KEY secret is missing/);
  // The build runs third-party code: read-only, no key. Only the tag-only publish job signs.
  assert.match(WORKFLOW, /^permissions:\n  contents: read$/m);
  const [build, publish] = WORKFLOW.split(/^  publish:$/m);
  assert.ok(publish && !build!.includes('secrets.'), 'no secret in the build job');
  assert.match(publish!, /if: github\.ref_type == 'tag'/);
  assert.match(publish!, /environment: release/);
  for (const line of WORKFLOW.matchAll(/uses: (\S+)/g)) assert.match(line[1]!, /@[0-9a-f]{40}$/, `${line[1]} is pinned by SHA`);
});

test('widget: a release installs only if its signed manifest names this tag, this file, these bytes', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const archive = Buffer.from('not really a tarball');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const file = assetName('v0.5.5');
  const signed = (text: string) => sign(null, Buffer.from(text), privateKey).toString('base64');
  const text = manifestText({ tag: 'v0.5.5', file, sha256 });
  assert.deepEqual(parseManifest(text), { tag: 'v0.5.5', file, sha256 });
  assert.equal(releaseProblem(archive, text, signed(text), { tag: 'v0.5.5', file }, pem), null);
  assert.match(releaseProblem(Buffer.from('tampered'), text, signed(text), { tag: 'v0.5.5', file }, pem)!, /SHA-256/);
  assert.match(releaseProblem(archive, text, signed(`${text} `), { tag: 'v0.5.5', file }, pem)!, /signature/);
  // An old genuine release re-published under a newer tag: the manifest still says the old one.
  assert.match(releaseProblem(archive, text, signed(text), { tag: 'v9.9.9', file }, pem)!, /for v0\.5\.5, not v9\.9\.9/);
  assert.match(releaseProblem(archive, text, signed(text), { tag: 'v0.5.5', file: 'other.tar.gz' }, pem)!, /not other/);
  // A legacy signed .sha256 is not a manifest, whatever its signature.
  const legacy = `${sha256}  ${file}\n`;
  assert.match(releaseProblem(archive, legacy, signed(legacy), { tag: 'v0.5.5', file }, pem)!, /malformed/);
  assert.equal(parseManifest(`${text}extra\n`), null);
});

test('sign-release: what the CI script writes is exactly what installs and the catalog accept', () => {
  const release = generateKeyPairSync('ed25519');
  const catalog = generateKeyPairSync('ed25519');
  const pub = (k: typeof release) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const priv = (k: typeof release) => k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const dir = mkdtempSync(join(tmpdir(), 'pet-sign-'));
  const file = assetName('v0.5.5');
  const archive = join(dir, file);
  writeFileSync(archive, 'not really a tarball');
  writeFileSync(`${archive}.sha256`, `${createHash('sha256').update('not really a tarball').digest('hex')}  ${file}\n`);
  const script = join(REPO, 'scripts', 'sign-release.ts');
  execFileSync(process.execPath, [script, '--release', 'v0.5.5', archive], { env: { ...process.env, RELEASE_SIGNING_KEY: priv(release) }, stdio: 'ignore' });
  const read = (p: string) => readFileSync(p, 'utf8');
  assert.equal(releaseProblem(readFileSync(archive), read(`${archive}.manifest`), read(`${archive}.manifest.sig`), { tag: 'v0.5.5', file }, pub(release)), null);
  assert.ok(verifySignature(readFileSync(`${archive}.sha256`), read(`${archive}.sha256.sig`), pub(release)), 'legacy signature for clients before v0.5.5');
  assert.throws(() => execFileSync(process.execPath, [script, '--release', 'v0.5.5;rm', archive],
    { env: { ...process.env, RELEASE_SIGNING_KEY: priv(release) }, stdio: 'ignore' }), 'a malformed tag is refused');

  const index = join(dir, 'index.json');
  writeFileSync(index, '{"format":1,"avatars":[]}');
  execFileSync(process.execPath, [script, '--catalog', index], { env: { ...process.env, CATALOG_SIGNING_KEY: priv(catalog) }, stdio: 'ignore' });
  assert.ok(verifySignature(catalogSignedBytes(readFileSync(index)), read(`${index}.catalog.sig`), pub(catalog)));
  assert.ok(!verifySignature(readFileSync(index), read(`${index}.catalog.sig`), pub(catalog)), 'the prefix is part of what is signed');
});
