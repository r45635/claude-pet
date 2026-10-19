import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFromLibrary, installPackage, removeAvatar } from '../src/avatars-cli.ts';
import type { Catalog } from '../src/catalog.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const manifest = (id: string, version = '1.0.0') =>
  JSON.stringify({ format: 1, id, name: id, version, license: 'MIT', kind: 'images', states: { IDLE: 'idle.png' } });

/** A .claudepet built with the system zip, from files laid out in a folder. */
function pack(files: Record<string, string | Uint8Array>, opts: { nested?: boolean; symlink?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-pkg-'));
  const src = join(dir, 'src');
  mkdirSync(src);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(src, name), content);
  const names = Object.keys(files);
  if (opts.symlink) {
    symlinkSync('/etc/hosts', join(src, opts.symlink));
    names.push(opts.symlink);
  }
  const out = join(dir, 'a.claudepet');
  if (opts.nested) {
    mkdirSync(join(src, 'sub'));
    writeFileSync(join(src, 'sub', 'x.png'), PNG);
    execFileSync('zip', ['-q', '-r', out, '.'], { cwd: src });
  } else {
    execFileSync('zip', ['-q', '-y', out, ...names], { cwd: src }); // -y: store symlinks as links
  }
  return out;
}
const home = () => mkdtempSync(join(tmpdir(), 'claude-pet-home-'));

test('cli install: a valid package lands flat, only referenced files, previous kept as .bak', async () => {
  const root = home();
  const pkg = pack({ 'manifest.json': manifest('demo'), 'idle.png': PNG, 'README.txt': 'not referenced' });
  assert.deepEqual(await installPackage(pkg, root), { id: 'demo', name: 'demo', version: '1.0.0' });
  assert.deepEqual(readdirSync(join(root, 'avatars', 'demo')).sort(), ['idle.png', 'manifest.json']);
  await installPackage(pack({ 'manifest.json': manifest('demo', '2.0.0'), 'idle.png': PNG }), root);
  assert.match(readFileSync(join(root, 'avatars', 'demo', 'manifest.json'), 'utf8'), /2\.0\.0/);
  assert.ok(existsSync(join(root, 'avatars', 'demo.bak')));
  assert.deepEqual(readdirSync(join(root, 'avatars')).filter((n) => n.startsWith('.')), [], 'no temp folder left');
});

test('cli install: nested paths, symlinks and invalid content are refused, nothing installed', async () => {
  for (const [pkg, why] of [
    [pack({ 'manifest.json': manifest('demo'), 'idle.png': PNG }, { nested: true }), /flat/],
    [pack({ 'manifest.json': manifest('demo') }, { symlink: 'idle.png' }), /plain files/],
    [pack({ 'manifest.json': manifest('demo'), 'idle.png': '<html>not a png</html>' }), /not \.png/],
    [pack({ 'manifest.json': manifest('classic'), 'idle.png': PNG }), /reserved/],
  ] as const) {
    const root = home();
    await assert.rejects(installPackage(pkg, root), why);
    assert.equal(existsSync(join(root, 'avatars', 'demo')), false);
    const left = existsSync(join(root, 'avatars')) ? readdirSync(join(root, 'avatars')) : [];
    assert.deepEqual(left.filter((n) => n.startsWith('.')), [], 'no temp folder left');
  }
});

test('cli library install: verified against the index, recorded, and must be the id asked for', async () => {
  const good = readFileSync(pack({ 'manifest.json': manifest('ghost'), 'idle.png': PNG }));
  const other = readFileSync(pack({ 'manifest.json': manifest('impostor'), 'idle.png': PNG }));
  const entry = (bytes: Buffer, id = 'ghost') => ({
    id, name: 'Ghost', names: {}, version: '1.0.0', kind: 'images' as const, license: 'MIT', author: null,
    file: `${id}.claudepet`, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
  });

  const root = home();
  const catalog: Catalog = { generated: '', avatars: [entry(good)] };
  await installFromLibrary('ghost', catalog, root, async () => good);
  const record = JSON.parse(readFileSync(join(root, 'avatars', 'ghost', '.install.json'), 'utf8'));
  assert.equal(record.source, 'library');
  assert.equal(record.sha256, catalog.avatars[0].sha256);

  await assert.rejects(installFromLibrary('nope', catalog, home(), async () => good), /not in the library/);
  await assert.rejects(installFromLibrary('ghost', catalog, home(), async () => other), /does not match/);
  const tricked = home();
  await assert.rejects(installFromLibrary('ghost', { generated: '', avatars: [entry(other)] }, tricked, async () => other), /installs "impostor"/);
  assert.equal(existsSync(join(tricked, 'avatars', 'impostor')), false);
});

test('cli remove: deletes the avatar and its backup, never classic', async () => {
  const root = home();
  await installPackage(pack({ 'manifest.json': manifest('demo'), 'idle.png': PNG }), root);
  await installPackage(pack({ 'manifest.json': manifest('demo'), 'idle.png': PNG }), root);
  removeAvatar('demo', root);
  assert.equal(existsSync(join(root, 'avatars', 'demo')) || existsSync(join(root, 'avatars', 'demo.bak')), false);
  assert.throws(() => removeAvatar('classic', root), /cannot be removed/);
  assert.throws(() => removeAvatar('../x', root), /cannot be removed/);
  assert.throws(() => removeAvatar('demo', root), /not installed/);
});
