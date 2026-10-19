/**
 * The avatar library (github.com/r45635/claude-pet-avatars): its signed catalog, what is
 * installed, and the download of one package.
 *
 * Trust: `index.json` is refused unless its ed25519 signature verifies against the pinned
 * release key (widget.ts) — no unsigned fallback, the library never published unsigned.
 * A package is then refused unless its bytes match the sha256 the signed index gives. The
 * daemon never unzips anything: Rust's avatars::import does, with its unchanged untrusted-
 * content rules (zip-slip, sizes, sniffing). The signature gates distribution; the import
 * gates content.
 *
 * Network: the same daily refresh as the update check, under the same `updatesCheck`
 * setting; each request carries nothing but its URL (docs/PRIVACY.md).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkManifest, FORMAT } from './avatar-format.ts';
import { ROOT_DIR } from './paths.ts';
import { verifySignature } from './widget.ts';

export const LIBRARY_REPO = 'r45635/claude-pet-avatars';
const latestUrl = (file: string) => `https://github.com/${LIBRARY_REPO}/releases/latest/download/${file}`;
const DOWNLOAD_PREFIX = '.avatar-dl-';
const MAX_ENTRIES = 500;

export type CatalogEntry = {
  id: string;
  name: string;
  names: Record<string, string>;
  version: string;
  kind: 'images' | 'svg';
  license: string;
  author: string | null;
  file: string;
  sha256: string;
  bytes: number;
};
export type Catalog = { generated: string; avatars: CatalogEntry[] };
export type CatalogView = {
  /** What the menu says: ok, loading (first fetch in flight), off (updatesCheck off), error. */
  status: 'ok' | 'loading' | 'off' | 'error';
  fetchedAt: string | null;
  error: string | null;
  avatars: (CatalogEntry & { installed: { version: string | null; updateAvailable: boolean } | null })[];
};

const ID = new RegExp(FORMAT.idPattern);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Check a parsed, already signature-verified index. Any bad entry refuses the whole catalog. */
export function parseCatalog(raw: unknown): Catalog | { error: string } {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== 'object' || c.format !== 1 || !Array.isArray(c.avatars)) return { error: 'catalog: not a format-1 index' };
  if (c.avatars.length > MAX_ENTRIES) return { error: 'catalog: too many entries' };
  const avatars: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const a of c.avatars as Record<string, unknown>[]) {
    const ok = a && typeof a === 'object'
      && typeof a.id === 'string' && ID.test(a.id) && !FORMAT.builtin.includes(a.id) && !seen.has(a.id)
      && str(a.name, 60) && str(a.version, 20) && (a.kind === 'images' || a.kind === 'svg')
      && str(a.license, 40) && (a.author === null || a.author === undefined || str(a.author, 60))
      && a.file === `${a.id}.claudepet`
      && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256)
      && Number.isInteger(a.bytes) && (a.bytes as number) > 0 && (a.bytes as number) <= FORMAT.limits.totalBytes;
    if (!ok) return { error: `catalog: invalid entry ${JSON.stringify(a?.id ?? null)}` };
    seen.add(a.id as string);
    const names = a.names && typeof a.names === 'object' && !Array.isArray(a.names)
      ? Object.fromEntries(Object.entries(a.names as Record<string, unknown>).filter(([k, v]) => k.length <= 8 && str(v, 60))) as Record<string, string>
      : {};
    avatars.push({
      id: a.id as string, name: a.name as string, names, version: a.version as string, kind: a.kind as CatalogEntry['kind'],
      license: a.license as string, author: (a.author as string | undefined) ?? null, file: a.file as string,
      sha256: a.sha256 as string, bytes: a.bytes as number,
    });
  }
  return { generated: typeof c.generated === 'string' ? c.generated : '', avatars };
}

/** Bytes of one URL, or null; async, bounded. */
export type FetchBytes = (url: string, maxBytes: number) => Promise<Buffer | null>;
const curlBytes: FetchBytes = (url, maxBytes) =>
  new Promise((resolve) => {
    execFile('curl', ['-fsSL', '--max-time', '60', '--max-filesize', String(maxBytes), url],
      { encoding: 'buffer', maxBuffer: maxBytes + 1, timeout: 65_000 },
      (error, stdout) => resolve(error ? null : stdout));
  });

/** Fetch, verify the signature, parse. Never throws. */
export async function fetchCatalog(fetchBytes: FetchBytes = curlBytes, pubkey?: string): Promise<Catalog | { error: string }> {
  const [index, sig] = await Promise.all([fetchBytes(latestUrl('index.json'), 1_048_576), fetchBytes(latestUrl('index.json.sig'), 1_024)]);
  if (!index || !sig) return { error: 'catalog: could not download the library index' };
  if (!verifySignature(index, sig.toString('utf8'), pubkey)) return { error: 'catalog: the index signature does not verify, refused' };
  try {
    return parseCatalog(JSON.parse(index.toString('utf8')));
  } catch {
    return { error: 'catalog: the index is not JSON' };
  }
}

/** Installed avatars and their manifest versions, read and checked like the tooling does. */
export function installedAvatars(root = ROOT_DIR): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const dir = join(root, 'avatars');
  if (!existsSync(dir)) return out;
  for (const id of readdirSync(dir)) {
    if (!ID.test(id)) continue; // <id>.bak, temporary import folders
    try {
      const errors: string[] = [];
      const { manifest } = checkManifest(JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8')), errors);
      if (manifest && manifest.id === id) out.set(id, manifest.version ?? null);
    } catch {
      /* unreadable: not installed as far as the library is concerned */
    }
  }
  return out;
}

/**
 * The menu's view. A free-form manifest version has no order, so "update available" means
 * "the signed catalog ships a different version" — the catalog is the source of truth.
 */
export function catalogView(catalog: Catalog | null, error: string | null, fetchedAt: string | null, installed: Map<string, string | null>,
  status: CatalogView['status'] = catalog ? 'ok' : error ? 'error' : 'loading'): CatalogView {
  return {
    status,
    fetchedAt,
    error,
    avatars: (catalog?.avatars ?? []).map((a) => {
      if (!installed.has(a.id)) return { ...a, installed: null };
      const version = installed.get(a.id) ?? null;
      return { ...a, installed: { version, updateAvailable: version !== a.version } };
    }),
  };
}

/**
 * Download one package to a fresh 0700 folder under the root and check it against the
 * signed index. Returns its path (Rust imports it, then deletes the folder) or an error.
 */
export async function downloadAvatar(entry: CatalogEntry, root = ROOT_DIR, fetchBytes: FetchBytes = curlBytes):
  Promise<{ path: string } | { error: string }> {
  const bytes = await fetchBytes(latestUrl(entry.file), entry.bytes);
  if (!bytes) return { error: `${entry.id}: download failed` };
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    return { error: `${entry.id}: the package does not match the signed index, refused` };
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, DOWNLOAD_PREFIX));
  const path = join(dir, entry.file);
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path };
}

/** Download folders left behind (a crash between download and import), swept at startup. */
export function sweepDownloads(root = ROOT_DIR, olderThanMs = 3_600_000): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(DOWNLOAD_PREFIX)) continue;
    const p = join(root, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > olderThanMs) rmSync(p, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
