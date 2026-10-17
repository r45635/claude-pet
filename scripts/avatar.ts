#!/usr/bin/env node
/**
 * Creator tooling for avatars (docs/AVATARS.md).
 *
 *   npm run avatar -- validate <folder>          check a folder against the format
 *   npm run avatar -- pack <folder> [out.claudepet]
 *
 * `pack` validates first, then zips only manifest.json and the files it references,
 * flat and without macOS metadata — exactly what the widget's importer accepts. Drag the
 * result onto the creature to install it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { validateDir } from '../packages/collector/src/avatar-format.ts';

function main(argv: string[]): number {
  const [command, folder, out] = argv;
  if ((command !== 'validate' && command !== 'pack') || !folder) {
    process.stderr.write('usage: npm run avatar -- validate <folder> | pack <folder> [out.claudepet]\n');
    return 2;
  }
  const dir = resolve(folder);
  const report = validateDir(dir);
  for (const w of report.warnings) process.stderr.write(`warning: ${w}\n`);
  for (const e of report.errors) process.stderr.write(`error: ${e}\n`);
  if (!report.manifest || report.errors.length > 0) {
    process.stderr.write(`✗ ${basename(dir)} is not a valid avatar\n`);
    return 1;
  }
  const { id, name, kind } = report.manifest;
  process.stdout.write(`✓ ${id} — "${name}" (${kind}, ${report.files.length} file(s))\n`);
  if (command === 'validate') return 0;

  const target = resolve(out ?? `${id}.claudepet`);
  if (existsSync(target)) rmSync(target);
  // -j: flat (no folders), -X: no extra file attributes, -q: quiet. /usr/bin/zip ships with macOS.
  execFileSync('zip', ['-j', '-X', '-q', target, join(dir, 'manifest.json'), ...report.files.map((f) => join(dir, f))]);
  process.stdout.write(`packed → ${target}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
