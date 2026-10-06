#!/usr/bin/env node
/**
 * Where the widget binary comes from, so that using the pet needs no Rust toolchain:
 *
 *   1. a local build (apps/widget/src-tauri/target/release) — contributors, always wins;
 *   2. otherwise the prebuilt one, downloaded once from this repo's GitHub Release for the
 *      checkout's version (.github/workflows/widget.yml publishes it) into
 *      ~/.claude-pet/bin/v<version>/.
 *
 * The download is the only outbound request in the codebase. It runs when the user asks
 * for it (`fetch`, or `autostart install` with no binary), never from the daemon or the
 * widget, and the archive is checked against its published SHA-256 before it is unpacked.
 * It goes through curl, which, unlike a browser, does not set com.apple.quarantine: the
 * binary is ad-hoc signed, not notarized, and Gatekeeper would otherwise refuse it.
 *
 *   node packages/collector/src/widget.ts [path|fetch] [--force] [--tag <tag>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR } from './paths.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string; repository: string };
export const VERSION = PKG.version;
/** "github:owner/name" → "owner/name" */
export const GITHUB_REPO = PKG.repository.replace(/^github:/, '');
export const TARGET = 'aarch64-apple-darwin';
const BIN = 'claude-pet-widget';

export const LOCAL_BUILD = join(REPO, 'apps', 'widget', 'src-tauri', 'target', 'release', BIN);
export const downloadedPath = (tag: string, root = ROOT_DIR): string => join(root, 'bin', tag, BIN);
export const assetName = (tag: string): string => `${BIN}-${tag}-${TARGET}.tar.gz`;
export const releaseUrl = (tag: string, file: string, repo = GITHUB_REPO): string =>
  `https://github.com/${repo}/releases/download/${tag}/${file}`;

/** The binary to run, or null when there is neither a local build nor a download yet. */
export function resolveWidget(tag = `v${VERSION}`, root = ROOT_DIR): string | null {
  for (const candidate of [LOCAL_BUILD, downloadedPath(tag, root)]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** `<hex>  <file>` as written by `shasum -a 256`; the hash must match the archive's. */
export function checksumMatches(archive: Buffer, sha256File: string): boolean {
  const expected = sha256File.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return /^[0-9a-f]{64}$/.test(expected) && createHash('sha256').update(archive).digest('hex') === expected;
}

function has(cmd: string): boolean {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Puts the archive and its .sha256 in `dir`. curl covers a public repository; while the
 * repository is private, an authenticated `gh` is the only way in, so it is the fallback.
 */
function download(tag: string, dir: string): void {
  const asset = assetName(tag);
  try {
    for (const name of [asset, `${asset}.sha256`]) {
      execFileSync('curl', ['-fsSL', '--retry', '2', '-o', join(dir, name), releaseUrl(tag, name)], { stdio: 'ignore' });
    }
    return;
  } catch {
    if (!has('gh')) throw new Error(`could not download ${releaseUrl(tag, asset)}`);
  }
  try {
    execFileSync('gh', ['release', 'download', tag, '-R', GITHUB_REPO, '-p', asset, '-p', `${asset}.sha256`, '-D', dir, '--clobber'], { stdio: 'ignore' });
  } catch {
    throw new Error(`could not download ${asset} from ${GITHUB_REPO} (no release ${tag}, or no access)`);
  }
}

/** Downloads, verifies and unpacks the prebuilt widget; returns its path. */
export function fetchWidget(tag = `v${VERSION}`, { force = false, root = ROOT_DIR } = {}): string {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`the prebuilt widget is for Apple Silicon Macs only (this is ${process.platform}/${process.arch}): build it instead`);
  }
  const dest = downloadedPath(tag, root);
  if (existsSync(dest) && !force) return dest;

  mkdirSync(join(root, 'bin'), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(root, 'bin', '.fetch-'));
  try {
    download(tag, tmp);
    const asset = assetName(tag);
    const archive = readFileSync(join(tmp, asset));
    if (!checksumMatches(archive, readFileSync(join(tmp, `${asset}.sha256`), 'utf8'))) {
      throw new Error(`${asset}: SHA-256 does not match the published one, not installed`);
    }
    execFileSync('tar', ['-xzf', join(tmp, asset), '-C', tmp, BIN]);
    chmodSync(join(tmp, BIN), 0o755);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    renameSync(join(tmp, BIN), dest);
    return dest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(argv: string[]): number {
  const i = argv.indexOf('--tag');
  const tag = i >= 0 && argv[i + 1] ? argv[i + 1] : `v${VERSION}`;
  if (argv.includes('fetch')) {
    try {
      process.stdout.write(`${fetchWidget(tag, { force: argv.includes('--force') })}\n`);
      return 0;
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }
  const bin = resolveWidget(tag);
  if (!bin) {
    process.stderr.write(`no widget binary yet: npm run fetch-widget (or build it: cd apps/widget && cargo tauri build --no-bundle)\n`);
    return 1;
  }
  process.stdout.write(`${bin}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
