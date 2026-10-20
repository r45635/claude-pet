#!/usr/bin/env node
/**
 * Creator tooling for avatars (docs/AVATARS.md).
 *
 *   npm run avatar -- validate <folder>          check a folder against the format
 *   npm run avatar -- pack <folder> [out.claudepet]
 *   npm run avatar -- from-sheet <sheet.png> <folder> --cell WxH --id … --name … --map IDLE=0,…
 *
 * `pack` validates first, then zips only manifest.json and the files it references,
 * flat and without macOS metadata — exactly what the widget's importer accepts. Drag the
 * result onto the creature to install it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { validateDir } from '../packages/collector/src/avatar-format.ts';
import { decodePng, parseMap, sheetToAvatar } from './sheet.ts';

const opt = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** A sprite sheet → an avatar folder (scripts/sheet.ts), then validated like any other. */
function fromSheet(argv: string[]): number {
  const [sheetFile, folder] = argv;
  const cell = /^(\d+)x(\d+)$/.exec(opt(argv, 'cell') ?? '');
  const id = opt(argv, 'id');
  const name = opt(argv, 'name');
  const map = opt(argv, 'map');
  if (!sheetFile || !folder || !cell || !id || !name || !map) {
    process.stderr.write('usage: npm run avatar -- from-sheet <sheet.png> <folder> --cell WxH --id <id> --name <name> ' +
      '--map IDLE=0,THINKING=1:6,… [--fps 8] [--license SPDX] [--author name]\n');
    return 2;
  }
  const dir = resolve(folder);
  if (existsSync(join(dir, 'manifest.json'))) {
    process.stderr.write(`${dir} already holds an avatar: choose an empty folder\n`);
    return 1;
  }
  try {
    const { manifest, files } = sheetToAvatar(decodePng(readFileSync(sheetFile)), {
      cell: { w: Number(cell[1]), h: Number(cell[2]) }, map: parseMap(map), id, name,
      fps: Number(opt(argv, 'fps') ?? 8), license: opt(argv, 'license'), author: opt(argv, 'author'),
    });
    mkdirSync(dir, { recursive: true });
    for (const [file, bytes] of files) writeFileSync(join(dir, file), bytes);
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`from-sheet: ${(err as Error).message}\n`);
    return 1;
  }
  if (!opt(argv, 'license')) process.stderr.write('warning: no --license: only publish a sheet you may redistribute\n');
  return main(['validate', folder]);
}

function main(argv: string[]): number {
  if (argv[0] === 'from-sheet') return fromSheet(argv.slice(1));
  const [command, folder, out] = argv;
  if ((command !== 'validate' && command !== 'pack') || !folder) {
    process.stderr.write('usage: npm run avatar -- validate <folder> | pack <folder> [out.claudepet] | from-sheet …\n');
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
