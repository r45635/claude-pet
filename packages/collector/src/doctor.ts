#!/usr/bin/env node
/**
 * `claude-pet doctor`: is the pet actually wired and fed? Each line is a check against
 * reality, not a status a component reports about itself — a daemon answering 200 proves
 * it runs, not that events reach it (docs/RISKS.md, "a green status is not a proof"):
 *
 *   - the hooks and the status line in ~/.claude/settings.json point at scripts that exist;
 *   - the daemon answers, runs this version, and its spool reader is caught up;
 *   - events are arriving: a `claude` process running with no hook event for minutes is
 *     the failure no other status shows;
 *   - the launch agents and the widget run.
 *
 * Read-only: it never writes settings.json, the config or the spool. `diagnose` is pure
 * (facts in, verdicts out) so every verdict is tested without a machine to break.
 *
 *   claude-pet doctor            (clone: npm run doctor)
 */

import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isMain, STANDALONE, VERSION } from './entry.ts';
import { BIN_DIR, HOOK_EVENTS, HOOK_SCRIPT, hookCommand, isOurs, settingsPath, statusCommand, STATUSLINE_SCRIPT, type Settings } from './install.ts';
import { LABELS } from './login.ts';
import { APP_DIR, ROOT_DIR, SPOOL_FILE, TOKEN_FILE } from './paths.ts';

export type Status = 'ok' | 'info' | 'warn' | 'fail';
export type Check = { name: string; status: Status; detail: string; fix?: string };

/** The subset of the daemon's GET /health that the verdicts read. */
export type Health = {
  events_seen: number;
  events_dropped: number;
  last_event_at: string | null;
  spool_offset: number;
  sources: { hooks: boolean; statusline: boolean; net?: boolean; transcript: boolean; otel: boolean };
  config_invalid: boolean;
  config_warnings: string[];
  version: string;
  update?: { available?: boolean; latest?: string | null };
};

export type Facts = {
  nowMs: number;
  version: string;
  /** Where this install's hook scripts are (the standalone app or the clone's bin/). */
  binDir: string;
  /** Command to run to (re)wire Claude Code, for the fixes. */
  setupCommand: string;
  jq: boolean;
  /** settings.json: null = missing; {error} = unreadable. */
  settings: Settings | { error: string } | null;
  settingsFile: string;
  /** Does a hook command's script exist on disk? (path → exists) */
  scriptExists: (path: string) => boolean;
  daemonUrl: string;
  /** /health, or why it could not be read. */
  health: Health | { error: string };
  spool: { size: number; lastEventMs: number | null } | null;
  claudeRunning: boolean;
  widgetRunning: boolean;
  agents: { label: string; installed: boolean; loaded: boolean }[];
};

/** Claude Code running this long with no hook event at all is not a quiet session. */
export const SILENCE_MS = 10 * 60_000;
/** The daemon's reader this far behind the spool is stuck, not busy. */
const LAG_BYTES = 64 * 1024;

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** The script path inside `sh "<path>"`, as install.ts writes it. */
export function scriptOf(command: string): string | null {
  const m = /^sh "((?:[^"\\]|\\.)*)"$/.exec(command.trim());
  return m ? m[1]!.replace(/\\(.)/g, '$1') : null;
}

function hooksCheck(f: Facts, settings: Settings): Check {
  const expected = hookCommand(f.binDir);
  const missing: string[] = [];
  const duplicated: string[] = [];
  const elsewhere = new Set<string>();
  const broken = new Set<string>();
  for (const event of HOOK_EVENTS) {
    const ours = (settings.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).filter((h) => isOurs(h.command, HOOK_SCRIPT));
    if (ours.length === 0) { missing.push(event); continue; }
    if (ours.length > 1) duplicated.push(event);
    for (const h of ours) {
      if (h.command === expected) continue;
      const path = scriptOf(h.command);
      if (path && f.scriptExists(path)) elsewhere.add(path);
      else broken.add(path ?? h.command);
    }
  }
  const n = HOOK_EVENTS.length;
  if (missing.length === n) return { name: 'hooks', status: 'fail', detail: 'not wired into Claude Code', fix: f.setupCommand };
  if (broken.size > 0) {
    return { name: 'hooks', status: 'fail', detail: `point at a script that does not exist: ${[...broken].join(', ')}`, fix: f.setupCommand };
  }
  if (missing.length > 0) {
    return { name: 'hooks', status: 'fail', detail: `${n - missing.length}/${n} events wired, missing: ${missing.join(', ')}`, fix: f.setupCommand };
  }
  if (duplicated.length > 0) {
    return { name: 'hooks', status: 'warn', detail: `wired twice on ${duplicated.join(', ')}: those events count double`,
             fix: `remove the extra claude-pet entries from ${f.settingsFile}, then ${f.setupCommand}` };
  }
  if (elsewhere.size > 0) {
    return { name: 'hooks', status: 'warn', detail: `${n}/${n} events wired, to another copy: ${[...elsewhere].join(', ')}`,
             fix: `${f.setupCommand} (to use this one)` };
  }
  return { name: 'hooks', status: 'ok', detail: `${n}/${n} Claude Code events wired to ${f.binDir}` };
}

function statusLineCheck(f: Facts, settings: Settings): Check {
  const line = settings.statusLine;
  const offline = 'the context and usage gauges stay offline';
  if (!line) return { name: 'status line', status: 'warn', detail: `not configured: ${offline}`, fix: f.setupCommand };
  if (!isOurs(line.command, STATUSLINE_SCRIPT)) {
    return { name: 'status line', status: 'warn', detail: `yours is configured, so ${offline}`,
             fix: `have your status line command also run ${join(f.binDir, STATUSLINE_SCRIPT)} (it prints a line and feeds the pet)` };
  }
  if (line.command === statusCommand(f.binDir)) return { name: 'status line', status: 'ok', detail: 'wired' };
  const path = scriptOf(line.command);
  if (path && f.scriptExists(path)) return { name: 'status line', status: 'warn', detail: `wired to another copy: ${path}`, fix: f.setupCommand };
  return { name: 'status line', status: 'fail', detail: `points at a script that does not exist: ${path ?? line.command}`, fix: f.setupCommand };
}

/** Pure: the facts of one machine → what is right and what to do about the rest. */
export function diagnose(f: Facts): Check[] {
  const checks: Check[] = [];
  checks.push(f.jq
    ? { name: 'jq', status: 'ok', detail: 'present' }
    : { name: 'jq', status: 'fail', detail: 'missing: the hooks write nothing without it', fix: 'brew install jq' });

  if (f.settings === null) {
    checks.push({ name: 'hooks', status: 'fail', detail: `${f.settingsFile} does not exist`, fix: f.setupCommand });
  } else if ('error' in f.settings) {
    checks.push({ name: 'hooks', status: 'fail', detail: `${f.settingsFile} is unreadable: ${f.settings.error}`,
                  fix: 'fix the JSON by hand (claude-pet never rewrites a file it cannot read)' });
  } else {
    checks.push(hooksCheck(f, f.settings), statusLineCheck(f, f.settings));
  }

  for (const a of f.agents) {
    const which = a.label.endsWith('daemon') ? 'daemon' : 'widget';
    if (!a.installed) checks.push({ name: `launch (${which})`, status: 'warn', detail: 'not started at login', fix: f.setupCommand });
    else if (!a.loaded) checks.push({ name: `launch (${which})`, status: 'warn', detail: 'installed but not loaded', fix: 'claude-pet restart' });
  }

  const h = f.health;
  if ('error' in h) {
    checks.push({ name: 'daemon', status: 'fail', detail: `not reachable at ${f.daemonUrl}: ${h.error}`, fix: 'claude-pet restart (log: ~/.claude-pet/logs/daemon.log)' });
  } else {
    checks.push(h.version === f.version
      ? { name: 'daemon', status: 'ok', detail: `v${h.version} at ${f.daemonUrl}` }
      : { name: 'daemon', status: 'warn', detail: `runs v${h.version}, this command is v${f.version}`, fix: 'claude-pet restart' });
    if (h.config_invalid) {
      checks.push({ name: 'config', status: 'fail', detail: `config.json is unreadable, the last good one is in use: ${h.config_warnings.join('; ')}`,
                    fix: 'fix ~/.claude-pet/config.json by hand' });
    } else if (h.config_warnings.length > 0) {
      checks.push({ name: 'config', status: 'warn', detail: `ignored: ${h.config_warnings.join('; ')}` });
    }
  }

  // Events: the one proof that the chain works end to end.
  const last = f.spool?.lastEventMs ?? null;
  const age = last === null ? null : f.nowMs - last;
  if (f.spool === null || last === null) {
    checks.push({ name: 'events', status: f.claudeRunning ? 'fail' : 'info',
                  detail: f.claudeRunning ? 'Claude Code is running but no hook event was ever written' : 'none yet: start a Claude Code session',
                  fix: f.claudeRunning ? 'check the hooks above, then restart your Claude Code sessions' : undefined });
  } else if (f.claudeRunning && age! > SILENCE_MS) {
    checks.push({ name: 'events', status: 'warn', detail: `Claude Code is running but the last hook event is ${minutes(age!)} old`,
                  fix: 'if it is working right now, its hooks are not loaded: restart that session' });
  } else {
    checks.push({ name: 'events', status: 'ok', detail: `last hook event ${age! < 60_000 ? 'under a minute' : minutes(age!)} ago` });
  }
  if (!('error' in h) && f.spool) {
    if (f.spool.size - h.spool_offset > LAG_BYTES) {
      checks.push({ name: 'reader', status: 'warn', detail: `the daemon is ${Math.round((f.spool.size - h.spool_offset) / 1024)} KB behind the spool`, fix: 'claude-pet restart' });
    }
    if (h.events_dropped > 0) {
      checks.push({ name: 'reader', status: 'warn', detail: `${h.events_dropped} spool line(s) could not be read (another version's format?)` });
    }
    if (h.events_seen > 0 && !h.sources.statusline) {
      checks.push({ name: 'gauges', status: 'info', detail: 'no status line sample yet: expected in the VS Code extension (it has no status line); a terminal session sends one per refresh' });
    }
  }

  checks.push(f.widgetRunning
    ? { name: 'widget', status: 'ok', detail: 'running' }
    : { name: 'widget', status: 'warn', detail: 'not running: no creature on screen', fix: 'claude-pet restart' });

  if (!('error' in h) && h.update?.available && h.update.latest) {
    checks.push({ name: 'update', status: 'info', detail: `${h.update.latest} is available` });
  }
  return checks;
}

// ---- the facts, from this machine ----------------------------------------------------------

function quiet(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Size, and the time of the last event: the last line of the spool's tail. */
export function spoolFacts(file = SPOOL_FILE): Facts['spool'] {
  if (!existsSync(file)) return null;
  const size = statSync(file).size;
  const n = Math.min(size, 8_192);
  const buf = Buffer.alloc(n);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, buf, 0, n, size - n);
  } finally {
    closeSync(fd);
  }
  let lastEventMs: number | null = null;
  for (const line of buf.toString('utf8').split('\n').reverse()) {
    try {
      const ts = Date.parse(JSON.parse(line).ts);
      if (Number.isFinite(ts)) { lastEventMs = ts; break; }
    } catch { /* a partial first line */ }
  }
  return { size, lastEventMs };
}

async function health(url: string): Promise<Facts['health']> {
  let token = '';
  try {
    token = readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return { error: 'no token file (the daemon never ran)' };
  }
  try {
    const res = await fetch(`${url}/health?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return (await res.json()) as Health;
  } catch (err) {
    return { error: (err as Error).cause ? String(((err as Error).cause as Error).message ?? (err as Error).cause) : (err as Error).message };
  }
}

export async function gather(): Promise<Facts> {
  const settingsFile = settingsPath();
  let settings: Facts['settings'] = null;
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8')) as Settings;
    } catch (err) {
      settings = { error: (err as Error).message };
    }
  }
  let daemonUrl = `http://127.0.0.1:${process.env.CLAUDE_PET_PORT ?? 8787}`;
  try {
    daemonUrl = JSON.parse(readFileSync(join(ROOT_DIR, 'endpoint.json'), 'utf8')).url ?? daemonUrl;
  } catch { /* the default port */ }
  const uid = process.getuid?.() ?? 0;
  return {
    nowMs: Date.now(),
    version: VERSION,
    binDir: STANDALONE ? join(APP_DIR, 'hooks') : BIN_DIR,
    setupCommand: STANDALONE ? 'claude-pet setup' : 'npm run install-hooks && npm run autostart -- install',
    jq: quiet('/bin/sh', ['-c', 'command -v jq']),
    settings,
    settingsFile,
    scriptExists: (path) => existsSync(path),
    daemonUrl,
    health: await health(daemonUrl),
    spool: spoolFacts(),
    claudeRunning: quiet('pgrep', ['-x', 'claude']),
    widgetRunning: quiet('pgrep', ['-f', 'claude-pet-widget']),
    agents: Object.values(LABELS).map((label) => ({
      label,
      installed: existsSync(join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${label}.plist`)),
      loaded: quiet('launchctl', ['print', `gui/${uid}/${label}`]),
    })),
  };
}

const MARK: Record<Status, string> = { ok: '✓', info: 'i', warn: '!', fail: '✗' };

export function format(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `  ${MARK[c.status]} ${c.name.padEnd(width)}  ${c.detail}${c.fix ? `\n    ${' '.repeat(width)}  → ${c.fix}` : ''}`).join('\n');
}

export async function main(_argv: string[] = []): Promise<number> {
  const checks = diagnose(await gather());
  process.stdout.write(`claude-pet doctor ${VERSION}\n${format(checks)}\n`);
  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  process.stdout.write(failed ? `\n${failed} problem(s) to fix.\n` : warned ? `\nworking, ${warned} thing(s) to look at.\n` : '\nall good.\n');
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
