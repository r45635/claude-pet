/**
 * The two ways this code runs: from a clone (`node packages/collector/src/<file>.ts`, one
 * entry point per file) or as the standalone `claude-pet` executable (cli.ts bundled into
 * a Node single executable application, see scripts/build-standalone.ts). In the latter,
 * every module shares the executable's import.meta.url, so "am I the entry point?" must
 * say no, or every main() would run at once.
 */

import { isSea } from 'node:sea';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../../../package.json' with { type: 'json' };

export const STANDALONE = isSea();
export const VERSION: string = pkg.version;
/** "github:owner/name" → "owner/name" */
export const GITHUB_REPO: string = pkg.repository.replace(/^github:/, '');

export const isMain = (metaUrl: string): boolean =>
  !STANDALONE && !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);
