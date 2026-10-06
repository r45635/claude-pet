#!/usr/bin/env node
/**
 * `claude-pet` — the standalone executable: this file, bundled with everything it imports
 * into a Node single executable application (scripts/build-standalone.ts). No Node, npm,
 * Rust or clone needed on the user's Mac.
 *
 * The release archive unpacks to
 *
 *   claude-pet/claude-pet           this executable
 *   claude-pet/claude-pet-widget    the Tauri widget
 *   claude-pet/hooks/*.sh           the hook and status line scripts (sh + jq)
 *
 * and `setup` copies that folder to ~/.claude-pet/app, so the download can be deleted and
 * an update is the same three lines again. Clones keep using the npm scripts.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { manage, type Launch, type Mode } from './autostart.ts';
import { VERSION } from './entry.ts';
import { HOOK_SCRIPT, main as installHooks, STATUSLINE_SCRIPT } from './install.ts';
import { APP_DIR, ROOT_DIR } from './paths.ts';
import { main as snapshot } from './snapshot.ts';

const EXE = 'claude-pet';
const WIDGET = 'claude-pet-widget';
const FILES = [EXE, WIDGET, join('hooks', HOOK_SCRIPT), join('hooks', STATUSLINE_SCRIPT)];

export const appLaunch = (app = APP_DIR): Launch => ({ daemon: [join(app, EXE), 'daemon'], widget: join(app, WIDGET) });

const USAGE = `claude-pet ${VERSION}

  claude-pet setup        install to ~/.claude-pet/app, wire into Claude Code, start at login
  claude-pet uninstall    stop it, unwire it, remove ~/.claude-pet/app (settings and logs stay)
  claude-pet status       whether the daemon and the widget are installed and running
  claude-pet restart      restart both
  claude-pet snapshot     what the creature currently sees (--watch to follow)
  claude-pet version
`;

/** Replaces ~/.claude-pet/app with the folder this executable was started from. */
function copyApp(from: string): void {
  if (resolve(from) === resolve(APP_DIR)) return; // `setup` again from the installed copy
  const missing = FILES.filter((f) => !existsSync(join(from, f)));
  if (missing.length > 0) throw new Error(`incomplete download, missing in ${from}: ${missing.join(', ')}`);
  mkdirSync(ROOT_DIR, { recursive: true, mode: 0o700 });
  const next = `${APP_DIR}.new`;
  const old = `${APP_DIR}.old`;
  rmSync(next, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  for (const f of FILES) cpSync(join(from, f), join(next, f));
  // A running daemon keeps its (renamed) executable until launchd restarts it below.
  if (existsSync(APP_DIR)) renameSync(APP_DIR, old);
  renameSync(next, APP_DIR);
  rmSync(old, { recursive: true, force: true });
}

function hasJq(): boolean {
  try {
    execFileSync('/bin/sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function setup(): number {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    process.stderr.write('claude-pet runs on Apple Silicon Macs only\n');
    return 1;
  }
  try {
    copyApp(dirname(process.execPath));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }
  process.stdout.write(`installed claude-pet ${VERSION} in ${APP_DIR}\n`);
  if (!hasJq()) {
    process.stderr.write('⚠️  jq not found: the hooks stay silent without it (macOS 26 ships it; else: brew install jq)\n');
  }
  if (installHooks(['install'], join(APP_DIR, 'hooks')) !== 0) return 1;
  return manage('install', appLaunch());
}

function uninstall(): number {
  manage('uninstall', appLaunch());
  if (installHooks(['uninstall']) !== 0) return 1;
  rmSync(APP_DIR, { recursive: true, force: true });
  process.stdout.write(`removed ${APP_DIR} (your settings and logs in ${ROOT_DIR} are kept)\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command = 'help', ...rest] = argv;
  switch (command) {
    case 'setup': return setup();
    case 'uninstall': return uninstall();
    case 'status':
    case 'restart': return manage(command as Mode, appLaunch());
    case 'daemon': await import('./daemon.ts'); return 0; // serves until killed
    case 'snapshot': return snapshot(rest);
    case 'version':
    case '--version': process.stdout.write(`${VERSION}\n`); return 0;
    case 'help':
    case '--help':
    case '-h': process.stdout.write(USAGE); return 0;
    default: process.stderr.write(`unknown command: ${command}\n\n${USAGE}`); return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
