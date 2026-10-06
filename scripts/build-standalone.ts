#!/usr/bin/env node
/**
 * Builds the standalone release: the `claude-pet` executable (cli.ts and everything it
 * imports, bundled by esbuild into one ES module, then made a Node single executable
 * application), next to the widget and the hook scripts, as one archive.
 *
 *   node scripts/build-standalone.ts [--widget <path>]
 *
 * → dist/claude-pet/                              the folder users unpack
 *   dist/claude-pet-aarch64-apple-darwin.tar.gz   + .sha256
 *
 * Must run on the official Node build (nodejs.org, or actions/setup-node): Homebrew's has
 * single executable applications disabled. The widget defaults to the local build.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(REPO, 'dist');
const APP = join(DIST, 'claude-pet');
export const ARCHIVE = 'claude-pet-aarch64-apple-darwin.tar.gz';

const argv = process.argv.slice(2);
const i = argv.indexOf('--widget');
const widget = i >= 0 && argv[i + 1]
  ? resolve(argv[i + 1])
  : join(REPO, 'apps', 'widget', 'src-tauri', 'target', 'release', 'claude-pet-widget');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(APP, 'hooks'), { recursive: true });

const bundle = join(DIST, 'cli.mjs');
await build({
  entryPoints: [join(REPO, 'packages', 'collector', 'src', 'cli.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
});

const seaConfig = join(DIST, 'sea.json');
const exe = join(APP, 'claude-pet');
writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  mainFormat: 'module',
  output: exe,
  disableExperimentalSEAWarning: true,
}));
try {
  execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
} catch {
  process.stderr.write(`node --build-sea failed: ${process.execPath} must be the official Node build (Homebrew's cannot)\n`);
  process.exit(1);
}
// Injecting the bundle invalidated node's signature, and Apple Silicon kills unsigned code.
execFileSync('codesign', ['--sign', '-', '--force', exe], { stdio: 'inherit' });

cpSync(widget, join(APP, 'claude-pet-widget'));
for (const script of ['claude-pet-hook.sh', 'claude-pet-statusline.sh']) {
  cpSync(join(REPO, 'packages', 'collector', 'bin', script), join(APP, 'hooks', script));
}
chmodSync(join(APP, 'claude-pet-widget'), 0o755);

execFileSync('tar', ['-czf', join(DIST, ARCHIVE), '-C', DIST, 'claude-pet']);
const sha = createHash('sha256').update(readFileSync(join(DIST, ARCHIVE))).digest('hex');
writeFileSync(join(DIST, `${ARCHIVE}.sha256`), `${sha}  ${ARCHIVE}\n`);
process.stdout.write(`${join(DIST, ARCHIVE)}\n${sha}\n`);
