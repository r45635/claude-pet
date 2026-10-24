/**
 * Release update detection (and, for the standalone layout, installation — see installUpdate).
 *
 * The daemon asks github.com once a day which tag `releases/latest` points at: one HEAD
 * request, carrying nothing but the URL, opt-out with the `updatesCheck` setting
 * (docs/PRIVACY.md). Everything here is async — the daemon's loop must never block on the
 * network — and nothing retries in a loop: one check per cycle, one install attempt per
 * detected version.
 */

import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GITHUB_REPO, VERSION } from './entry.ts';
import { LABELS } from './login.ts';
import { APP_DIR, ROOT_DIR } from './paths.ts';
import { manifestName } from './manifest.ts';
import { CURL_HTTPS, releaseProblem, releaseUrl } from './widget.ts';

/** The standalone release archive (scripts/build-standalone.ts) and what it must contain. */
export const STANDALONE_ARCHIVE = 'claude-pet-aarch64-apple-darwin.tar.gz';
const APP_FILES = ['claude-pet', 'claude-pet-widget', 'hooks/claude-pet-hook.sh', 'hooks/claude-pet-statusline.sh'];

export type UpdateState = {
  available: boolean;
  latest: string | null;
  checkedAt: string | null;
  installing: boolean;
  error: string | null;
  pinnedLocalBuild: boolean;
  layout: 'standalone' | 'clone';
};

export const freshUpdateState = (layout: UpdateState['layout'], pinnedLocalBuild: boolean): UpdateState => ({
  available: false,
  latest: null,
  checkedAt: null,
  installing: false,
  error: null,
  pinnedLocalBuild,
  layout,
});

/** `v1.2.3` or `v1.2.3-rc1` → comparable parts; null when it is not a release tag. */
export function parseTag(tag: string): { nums: [number, number, number]; pre: string | null } | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(tag.trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** > 0 when `a` is newer than `b`; a prerelease is older than its release. */
export function compareTags(a: string, b: string): number {
  const pa = parseTag(a);
  const pb = parseTag(b);
  if (!pa || !pb) return 0; // unparseable: never claim an update
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if ((pa.pre === null) !== (pb.pre === null)) return pa.pre === null ? 1 : -1;
  return pa.pre === pb.pre ? 0 : (pa.pre ?? '') < (pb.pre ?? '') ? -1 : 1;
}

/** The tag `releases/latest` redirects to, read from the Location header of one HEAD request. */
export function latestTagFromHeaders(headers: string): string | null {
  const m = /^location:\s*\S*\/releases\/tag\/([^\s/]+)\s*$/im.exec(headers);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null; // a malformed %-escape in the redirect: no tag, not a crash
  }
}

export function latestTag(repo = GITHUB_REPO): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-fsSI', ...CURL_HTTPS, '--max-time', '20', `https://github.com/${repo}/releases/latest`],
      { timeout: 25_000 },
      (error, stdout) => resolve(error ? null : latestTagFromHeaders(stdout)),
    );
  });
}

/** One detection pass; never throws. */
export async function checkForUpdate(state: UpdateState, current = `v${VERSION}`): Promise<UpdateState> {
  const latest = await latestTag();
  const checkedAt = new Date().toISOString();
  if (!latest) {
    return { ...state, checkedAt, error: 'update check: could not read releases/latest' };
  }
  return { ...state, checkedAt, latest, error: null, available: compareTags(latest, current) > 0 };
}

// ---- installation (standalone layout only) --------------------------------------------------

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((ok, ko) => execFile(cmd, args, { timeout: 180_000 }, (e) => (e ? ko(e) : ok())));

/** Puts `file` of release `tag` at `dest`; rejects when it is not published. */
export type FetchAsset = (tag: string, file: string, dest: string) => Promise<void>;
const curlAsset: FetchAsset = (tag, file, dest) =>
  run('curl', ['-fsSL', ...CURL_HTTPS, '--retry', '2', '--max-time', '170', '-o', dest, releaseUrl(tag, file)]);

export type InstallResult = { ok: true } | { ok: false; error: string };

/** Every path under `dir` that is neither a directory nor a regular file (a symlink…). */
function oddEntries(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => {
    const st = lstatSync(join(dir, p));
    return !st.isDirectory() && !st.isFile();
  });
}

/**
 * Download, verify and swap in the standalone release `tag`. Nothing in ~/.claude-pet/app is
 * touched until the release manifest's signature verifies, the manifest names this tag and
 * this archive with its SHA-256, and the unpacked folder holds every expected file as a
 * regular file; the previous version is kept as app.old (rollback:
 * `mv ~/.claude-pet/app.old ~/.claude-pet/app`, then `claude-pet restart`).
 *
 * Only a version newer than `current` installs: an older signed release, however genuine,
 * is a downgrade. No signature, no install — there is no "install anyway". Never throws:
 * every failure comes back as `{ok:false, error}`.
 */
export async function installStandalone(
  tag: string,
  { root = ROOT_DIR, app = APP_DIR, fetchAsset = curlAsset, pubkey, current = `v${VERSION}` }:
    { root?: string; app?: string; fetchAsset?: FetchAsset; pubkey?: string; current?: string } = {},
): Promise<InstallResult> {
  if (!parseTag(tag)) return { ok: false, error: `not a release tag: ${tag}` };
  if (compareTags(tag, current) <= 0) return { ok: false, error: `${tag} is not newer than the installed ${current}, not installed` };
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(root, '.update-'));
  try {
    const archive = join(tmp, STANDALONE_ARCHIVE);
    const manifest = join(tmp, manifestName(STANDALONE_ARCHIVE));
    try {
      await fetchAsset(tag, STANDALONE_ARCHIVE, archive);
      await fetchAsset(tag, manifestName(STANDALONE_ARCHIVE), manifest);
      await fetchAsset(tag, `${manifestName(STANDALONE_ARCHIVE)}.sig`, `${manifest}.sig`);
    } catch {
      return { ok: false, error: `could not download ${STANDALONE_ARCHIVE} and its signed manifest for ${tag}` };
    }
    const problem = releaseProblem(readFileSync(archive), readFileSync(manifest, 'utf8'), readFileSync(`${manifest}.sig`, 'utf8'),
                                   { tag, file: STANDALONE_ARCHIVE }, pubkey);
    if (problem) return { ok: false, error: `${tag}: ${problem}, not installed` };

    const unpacked = join(tmp, 'claude-pet');
    mkdirSync(unpacked);
    await run('tar', ['-xzf', archive, '-C', tmp]);
    const odd = oddEntries(unpacked);
    if (odd.length > 0) return { ok: false, error: `${tag}: archive holds links or special files (${odd.join(', ')}), not installed` };
    const missing = APP_FILES.filter((f) => !existsSync(join(unpacked, f)));
    if (missing.length > 0) return { ok: false, error: `${tag}: archive incomplete, missing ${missing.join(', ')}` };
    for (const f of ['claude-pet', 'claude-pet-widget']) chmodSync(join(unpacked, f), 0o755);

    // The swap: one rollback copy, the newest previous version.
    const old = `${app}.old`;
    rmSync(old, { recursive: true, force: true });
    if (existsSync(app)) renameSync(app, old);
    try {
      renameSync(unpacked, app);
    } catch (e) {
      if (existsSync(old) && !existsSync(app)) renameSync(old, app); // put the working version back
      return { ok: false, error: `${tag}: could not swap in the new version (${(e as Error).message})` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `${tag}: ${(e as Error).message}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Restart onto the new binaries: the widget first, the daemon last, from a detached shell —
 * the daemon calling kickstart -k on its own label would be killed mid-call (autostart.ts).
 * The widget's KeepAlive is crash-only, so it is kickstarted explicitly, never left to it.
 */
export function restartDetached(uid = process.getuid?.() ?? 501): void {
  const k = (label: string) => `launchctl kickstart -k gui/${uid}/${label}`;
  spawn('/bin/sh', ['-c', `sleep 1; ${k(LABELS.widget)}; sleep 1; ${k(LABELS.daemon)}`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

