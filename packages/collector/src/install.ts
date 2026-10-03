#!/usr/bin/env node
/**
 * Wires the pet into Claude Code — the only code in this repo that touches the user's
 * working environment, so it is deliberately conservative:
 *
 *   - it MERGES: existing hooks (e.g. the memory hub's SessionStart/Stop) are never touched;
 *   - it is idempotent: our entries are recognised by script name and never duplicated;
 *   - it backs the file up before any write, and writes atomically (tmp + rename);
 *   - a foreign `statusLine` is left alone — the hooks are installed, the meter is not;
 *   - `uninstall` removes only our entries, so install → uninstall is a semantic no-op.
 *
 *   node packages/collector/src/install.ts [install|uninstall] [--dry-run] [--settings <file>]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT_DIR } from './paths.ts';

const BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
export const HOOK_SCRIPT = 'claude-pet-hook.sh';
export const STATUSLINE_SCRIPT = 'claude-pet-statusline.sh';

/** Every event `claude-pet-hook.sh` maps to a PetEvent. Unmapped events cost a fork for nothing. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PermissionRequest',
  'PermissionDenied',
  'Notification',
  'MessageDisplay',
  'SessionStart',
  'SessionEnd',
  'PostCompact',
] as const;

/** Seconds. The hook is ~5 ms; this only bounds a pathological hang (see docs/RISKS.md §1). */
const HOOK_TIMEOUT_S = 2;

type HookCommand = { type: string; command: string; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks: HookCommand[]; [k: string]: unknown };
export type Settings = {
  hooks?: Record<string, HookGroup[]>;
  statusLine?: { type: string; command: string; [k: string]: unknown };
  [k: string]: unknown;
};

export type Plan = { settings: Settings; changes: string[]; warnings: string[] };

const quote = (p: string): string => `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
const isOurs = (cmd: unknown, script: string): boolean =>
  typeof cmd === 'string' && cmd.includes(script);

export function planInstall(input: Settings, binDir = BIN_DIR): Plan {
  const settings: Settings = structuredClone(input);
  const changes: string[] = [];
  const warnings: string[] = [];
  const hookCmd = `sh ${quote(join(binDir, HOOK_SCRIPT))}`;
  const statusCmd = `sh ${quote(join(binDir, STATUSLINE_SCRIPT))}`;

  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const groups = (settings.hooks[event] ??= []);
    const present = groups.some((g) => g.hooks?.some((h) => isOurs(h.command, HOOK_SCRIPT)));
    if (present) continue;
    groups.push({ hooks: [{ type: 'command', command: hookCmd, timeout: HOOK_TIMEOUT_S }] });
    changes.push(`+ hooks.${event}`);
  }

  const current = settings.statusLine;
  if (current === undefined) {
    settings.statusLine = { type: 'command', command: statusCmd, padding: 0 };
    changes.push('+ statusLine');
  } else if (!isOurs(current.command, STATUSLINE_SCRIPT)) {
    warnings.push(
      'a statusLine is already configured and was left untouched: the context/token meter ' +
        'stays offline (sources.statusline=false) until it wraps claude-pet-statusline.sh',
    );
  }

  return { settings, changes, warnings };
}

export function planUninstall(input: Settings): Plan {
  const settings: Settings = structuredClone(input);
  const changes: string[] = [];

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h.command, HOOK_SCRIPT)) }))
      .filter((g) => g.hooks.length > 0);
    const removed = groups.reduce((n, g) => n + g.hooks.length, 0) -
      kept.reduce((n, g) => n + g.hooks.length, 0);
    if (removed === 0) continue;
    changes.push(`- hooks.${event}`);
    if (kept.length > 0) settings.hooks![event] = kept;
    else delete settings.hooks![event];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (settings.statusLine && isOurs(settings.statusLine.command, STATUSLINE_SCRIPT)) {
    delete settings.statusLine;
    changes.push('- statusLine');
  }

  return { settings, changes, warnings: [] };
}

function settingsPath(argv: string[]): string {
  const i = argv.indexOf('--settings');
  if (i >= 0 && argv[i + 1]) return resolve(argv[i + 1]);
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(dir, 'settings.json');
}

function main(argv: string[]): number {
  const mode = argv.includes('uninstall') ? 'uninstall' : 'install';
  const dryRun = argv.includes('--dry-run');
  const file = settingsPath(argv);

  const before: Settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const plan = mode === 'install' ? planInstall(before) : planUninstall(before);

  for (const w of plan.warnings) process.stderr.write(`⚠️  ${w}\n`);
  if (plan.changes.length === 0) {
    process.stdout.write(`${mode}: nothing to do — ${file} is already in the wanted state\n`);
    return 0;
  }
  process.stdout.write(`${mode} → ${file}\n${plan.changes.map((c) => `  ${c}`).join('\n')}\n`);

  if (dryRun) {
    process.stdout.write(`\n--dry-run: resulting file would be:\n${JSON.stringify(plan.settings, null, 2)}\n`);
    return 0;
  }

  if (existsSync(file)) {
    const backups = join(ROOT_DIR, 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(backups, `settings.${stamp}.json`);
    copyFileSync(file, backup);
    process.stdout.write(`backup: ${backup}\n`);
  }

  const tmp = `${file}.claude-pet.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan.settings, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  process.stdout.write(`written. Restart Claude Code sessions for hooks to take effect.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
