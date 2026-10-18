import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogView, downloadAvatar, fetchCatalog, installedAvatars, parseCatalog, type FetchBytes } from '../src/catalog.ts';

const KEYS = generateKeyPairSync('ed25519');
const PUB = KEYS.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const PKG = Buffer.from('PK\x03\x04 pretend this is a .claudepet');
const SHA = createHash('sha256').update(PKG).digest('hex');
const entry = (over: Record<string, unknown> = {}) => ({
  id: 'ghost', name: 'Ghost', names: { fr: 'Fantôme' }, version: '1.1.0', kind: 'images', license: 'MIT',
  author: 'claude-pet', file: 'ghost.claudepet', sha256: SHA, bytes: PKG.length, ...over,
});

/** A fake library: index.json signed with the test key, plus one package. */
function library(index: unknown, { signWith = KEYS.privateKey, tamper = false } = {}): FetchBytes {
  const json = Buffer.from(JSON.stringify(index));
  const sig = sign(null, json, signWith).toString('base64');
  return async (url) => {
    if (url.endsWith('/index.json')) return tamper ? Buffer.concat([json, Buffer.from(' ')]) : json;
    if (url.endsWith('/index.json.sig')) return Buffer.from(sig);
    if (url.endsWith('/ghost.claudepet')) return PKG;
    return null;
  };
}

test('catalog: a signed index parses; names are kept, junk names dropped', async () => {
  const c = await fetchCatalog(library({ format: 1, generated: 'now', avatars: [entry({ names: { fr: 'Fantôme', 'way-too-long': 'x' } })] }), PUB);
  assert.ok(!('error' in c));
  assert.equal(c.avatars[0].id, 'ghost');
  assert.deepEqual(c.avatars[0].names, { fr: 'Fantôme' });
});

test('catalog: unsigned, tampered or foreign-key indexes are refused', async () => {
  const idx = { format: 1, avatars: [entry()] };
  assert.match((await fetchCatalog(library(idx, { tamper: true }), PUB) as { error: string }).error, /signature/);
  assert.match((await fetchCatalog(library(idx, { signWith: generateKeyPairSync('ed25519').privateKey }), PUB) as { error: string }).error, /signature/);
  assert.match((await fetchCatalog(library(idx)) as { error: string }).error, /signature/, 'the pinned key is not the test key');
  const noSig: FetchBytes = async (url) => (url.endsWith('.sig') ? null : Buffer.from(JSON.stringify(idx)));
  assert.match((await fetchCatalog(noSig, PUB) as { error: string }).error, /download/);
});

test('catalog: any malformed entry refuses the whole catalog', () => {
  for (const bad of [
    entry({ id: '../evil' }), entry({ id: 'classic' }), entry({ file: '../../x.claudepet' }),
    entry({ sha256: 'nothex' }), entry({ bytes: 999_999_999 }), entry({ kind: 'exe' }), entry({ license: '' }),
  ]) {
    assert.ok('error' in parseCatalog({ format: 1, avatars: [bad] }), JSON.stringify(bad));
  }
  assert.ok('error' in parseCatalog({ format: 1, avatars: [entry(), entry()] }), 'duplicate id');
  assert.ok('error' in parseCatalog({ format: 2, avatars: [] }));
});

test('catalog: installed versions merge in; a different version is an update', () => {
  const c = parseCatalog({ format: 1, avatars: [entry(), entry({ id: 'mint', file: 'mint.claudepet' })] });
  assert.ok(!('error' in c));
  const view = catalogView(c, null, 'now', new Map([['ghost', '1.0.0']]));
  assert.deepEqual(view.avatars[0].installed, { version: '1.0.0', updateAvailable: true });
  assert.equal(view.avatars[1].installed, null);
  assert.equal(catalogView(c, null, 'now', new Map([['ghost', '1.1.0']])).avatars[0].installed?.updateAvailable, false);
});

test('catalog: the installed list reads valid manifests only', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-pet-cat-'));
  const ok = join(root, 'avatars', 'ghost');
  mkdirSync(ok, { recursive: true });
  writeFileSync(join(ok, 'manifest.json'), JSON.stringify({ format: 1, id: 'ghost', name: 'Ghost', version: '1.0.0', kind: 'images', states: { IDLE: 'i.png' } }));
  mkdirSync(join(root, 'avatars', 'ghost.bak'));
  mkdirSync(join(root, 'avatars', 'broken'));
  assert.deepEqual([...installedAvatars(root)], [['ghost', '1.0.0']]);
});

test('download: the bytes must match the signed index; the file is private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-pet-dl-'));
  const good = await downloadAvatar(entry() as never, root, async () => PKG);
  assert.ok('path' in good);
  assert.deepEqual(readFileSync(good.path), PKG);
  assert.equal(statSync(good.path).mode & 0o777, 0o600);
  const bad = await downloadAvatar(entry() as never, root, async () => Buffer.from('swapped'));
  assert.match((bad as { error: string }).error, /does not match/);
  assert.equal(existsSync(join(root, 'avatars')), false, 'nothing installed by the daemon');
});
