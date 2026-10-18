/**
 * Release update detection (and, for the standalone layout, installation — see installUpdate).
 *
 * The daemon asks github.com once a day which tag `releases/latest` points at: one HEAD
 * request, carrying nothing but the URL, opt-out with the `updatesCheck` setting
 * (docs/PRIVACY.md). Everything here is async — the daemon's loop must never block on the
 * network — and nothing retries in a loop: one check per cycle, one install attempt per
 * detected version.
 */

import { execFile } from 'node:child_process';
import { GITHUB_REPO, VERSION } from './entry.ts';

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
  return m ? decodeURIComponent(m[1]) : null;
}

export function latestTag(repo = GITHUB_REPO): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'curl',
      ['-fsSI', '--max-time', '20', `https://github.com/${repo}/releases/latest`],
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
