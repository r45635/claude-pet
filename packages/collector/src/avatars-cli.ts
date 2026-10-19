#!/usr/bin/env node
/**
 * The avatar library from the command line — for people, and for agents that cannot click
 * a native menu:
 *
 *   claude-pet avatars list                 standalone install
 *   claude-pet avatars install <id>
 *   claude-pet avatars update [<id>]        every installed library avatar by default
 *   claude-pet avatars remove <id>
 *   npm run avatars -- <same>               from a clone
 *
 * Same trust chain as the menu (catalog.ts): the library index must verify against the
 * pinned release key, each package must match its signed SHA-256. Installing applies the
 * importer's rules — flat entries only, bounded sizes, then the format's own validation
 * (validateDir) — and swaps the folder in atomically, keeping `<id>.bak`. The widget
 * re-checks everything again at every load (avatars.rs) and sanitizes in the page.
 * Explicit commands fetch even when the daily check is off: the user asked.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FORMAT, validateDir } from './avatar-format.ts';
import { downloadAvatar, fetchCatalog, installedAvatars, LIBRARY_REPO, type Catalog, type FetchBytes } from './catalog.ts';
import { isMain } from './entry.ts';
import { ROOT_DIR } from './paths.ts';

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((ok, ko) => execFile(cmd, args, { timeout: 60_000, maxBuffer: 4_000_000 }, (e, out) => (e ? ko(e) : ok(String(out)))));

/** Entry names and uncompressed sizes, from `unzip -Z -l` (zipinfo, long format). */
async function zipEntries(pkg: string): Promise<{ name: string; size: number; kind: string }[]> {
  const out = await run('/usr/bin/unzip', ['-Z', '-l', pkg]);
  const entries: { name: string; size: number; kind: string }[] = [];
  for (const line of out.split('\n')) {
    // -rw-r--r--  3.0 unx     1234 tx     567 defN 26-Jan-01 00:00 manifest.json
    // Only entries this matches are ever extracted (unzip is given their names).
    const m = /^([-dlrwxsStT]{10})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m) entries.push({ kind: m[1][0], size: Number(m[2]), name: m[3] });
  }
  return entries;
}

/**
 * Install a `.claudepet` file into `root/avatars/<id>`: the same rules as the widget's
 * importer, so a package the widget would refuse is refused here.
 */
export async function installPackage(pkg: string, root = ROOT_DIR): Promise<{ id: string; name: string; version: string | null }> {
  const entries = (await zipEntries(pkg)).filter((e) => !e.name.startsWith('__MACOSX/') && !e.name.endsWith('/'));
  if (entries.length === 0) throw new Error('not a .claudepet (zip) file, or empty');
  if (entries.length > FORMAT.limits.files + 1) throw new Error('too many files');
  let total = 0;
  for (const e of entries) {
    // A symlink with a flat name would make the widget read any file it points to.
    if (e.kind !== '-') throw new Error(`${e.name}: only plain files are allowed`);
    if (e.name.includes('/') || e.name.includes('\\') || e.name.startsWith('.') || e.name.includes('..')) {
      throw new Error(`${e.name}: files must be flat, at the top level`);
    }
    if (e.size > FORMAT.limits.fileBytes) throw new Error(`${e.name}: too large`);
    total += e.size;
  }
  if (total > FORMAT.limits.totalBytes) throw new Error('the avatar is too large');

  const avatars = join(root, 'avatars');
  mkdirSync(avatars, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(avatars, `.import-cli-${process.pid}-`));
  let clean = '';
  try {
    await run('/usr/bin/unzip', ['-q', '-o', pkg, ...entries.map((e) => e.name), '-d', tmp]);
    const report = validateDir(tmp);
    if (!report.manifest || report.errors.length > 0) throw new Error(report.errors.join('; ') || 'invalid avatar');
    const { id, name, version } = report.manifest;
    // Keep only what the manifest references, like the widget's importer.
    clean = mkdtempSync(join(avatars, `.import-cli-${process.pid}-`));
    for (const f of ['manifest.json', ...report.files]) renameSync(join(tmp, f), join(clean, f));
    const target = join(avatars, id);
    const backup = join(avatars, `${id}.bak`);
    if (existsSync(target)) {
      rmSync(backup, { recursive: true, force: true });
      renameSync(target, backup);
    }
    renameSync(clean, target);
    clean = '';
    return { id, name, version: version ?? null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (clean) rmSync(clean, { recursive: true, force: true });
  }
}

/** Download a library avatar, verify it against the signed index, install it, record it. */
export async function installFromLibrary(id: string, catalog: Catalog, root = ROOT_DIR, fetchBytes?: FetchBytes) {
  const entry = catalog.avatars.find((a) => a.id === id);
  if (!entry) throw new Error(`"${id}" is not in the library (claude-pet avatars list)`);
  const dl = await downloadAvatar(entry, root, fetchBytes);
  if ('error' in dl) throw new Error(dl.error);
  try {
    const installed = await installPackage(dl.path, root);
    if (installed.id !== id) {
      rmSync(join(root, 'avatars', installed.id), { recursive: true, force: true });
      throw new Error(`the package installs "${installed.id}", not "${id}"`);
    }
    writeFileSync(join(root, 'avatars', id, '.install.json'),
      JSON.stringify({ source: 'library', sha256: entry.sha256, installed_at: Math.floor(Date.now() / 1000) }));
    return installed;
  } finally {
    rmSync(dirname(dl.path), { recursive: true, force: true });
  }
}

export function removeAvatar(id: string, root = ROOT_DIR): void {
  if (!new RegExp(FORMAT.idPattern).test(id) || FORMAT.builtin.includes(id)) throw new Error(`"${id}" cannot be removed`);
  const target = join(root, 'avatars', id);
  if (!existsSync(join(target, 'manifest.json'))) throw new Error(`"${id}" is not installed`);
  rmSync(target, { recursive: true, force: true });
  rmSync(join(root, 'avatars', `${id}.bak`), { recursive: true, force: true });
}

/** Tell a running daemon (if any): switch to an avatar, and/or reload the one on screen. */
async function notifyDaemon(root: string, patch: Record<string, unknown> | null): Promise<void> {
  try {
    const { url, token } = JSON.parse(readFileSync(join(root, 'endpoint.json'), 'utf8'));
    if (patch) await fetch(`${url}/config?token=${token}`, { method: 'POST', body: JSON.stringify(patch) });
    await fetch(`${url}/avatars/changed?token=${token}`, { method: 'POST' });
  } catch {
    /* no daemon running: the widget picks the change up at its next start */
  }
}

function currentAvatar(root: string): string {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))?.ui?.avatar ?? 'classic';
  } catch {
    return 'classic';
  }
}

const USAGE = `claude-pet avatars — the avatar library (github.com/${LIBRARY_REPO})

  list                 every library avatar, and which ones are installed
  install <id>         download (signature-checked), install and show it
  update [<id>]        update one, or every installed library avatar with a new version
  remove <id>          uninstall (the creature goes back to classic if it was showing it)
`;

export async function main(argv: string[], root = ROOT_DIR): Promise<number> {
  const [command, id] = argv;
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const fail = (s: string) => { process.stderr.write(`${s}\n`); return 1; };
  if (!command || command === 'help' || command === '--help') { out(USAGE); return 0; }
  if (command === 'remove') {
    if (!id) return fail('usage: avatars remove <id>');
    try {
      removeAvatar(id, root);
    } catch (e) {
      return fail((e as Error).message);
    }
    await notifyDaemon(root, currentAvatar(root) === id ? { avatar: 'classic' } : null);
    out(`removed ${id}`);
    return 0;
  }
  if (!['list', 'install', 'update'].includes(command)) return fail(`unknown command: ${command}\n\n${USAGE}`);

  const catalog = await fetchCatalog();
  if ('error' in catalog) return fail(catalog.error);
  const installed = installedAvatars(root);

  if (command === 'list') {
    for (const a of catalog.avatars) {
      const have = installed.has(a.id) ? installed.get(a.id) ?? '?' : null;
      const status = have === null ? '' : have === a.version ? '  [installed]' : `  [installed ${have} → update ${a.version}]`;
      out(`${a.id.padEnd(16)} ${a.name.padEnd(18)} ${a.version.padEnd(8)} ${a.kind.padEnd(6)} ${a.license}${status}`);
    }
    out(`\ninstall one: claude-pet avatars install <id>   (from a clone: npm run avatars -- install <id>)`);
    return 0;
  }
  const targets = command === 'install'
    ? (id ? [id] : [])
    : id ? [id] : catalog.avatars.filter((a) => installed.has(a.id) && installed.get(a.id) !== a.version).map((a) => a.id);
  if (command === 'install' && !id) return fail('usage: avatars install <id>   (see: avatars list)');
  if (targets.length === 0) { out('everything is up to date'); return 0; }
  let failed = 0;
  for (const t of targets) {
    try {
      const r = await installFromLibrary(t, catalog, root);
      out(`${command === 'install' ? 'installed' : 'updated'} ${r.id} ${r.version ?? ''} — ${r.name}`);
    } catch (e) {
      failed += 1;
      process.stderr.write(`${t}: ${(e as Error).message}\n`);
    }
  }
  // Show what was just installed; for an update, reload the avatar on screen.
  await notifyDaemon(root, command === 'install' && failed === 0 ? { avatar: targets[0] } : null);
  return failed > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
