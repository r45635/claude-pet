#!/usr/bin/env node
/**
 * Starts the pet at login: two per-user LaunchAgents, one for the daemon, one for the
 * widget. No sudo, nothing outside ~/Library/LaunchAgents and ~/.claude-pet.
 *
 *   node packages/collector/src/autostart.ts [install|uninstall|status|restart] [--dry-run]
 *
 * `restart` (after a pull or a rebuild) has launchd stop and start both, so the new code
 * runs without a second, hand-launched copy fighting the managed one.
 *
 * Start order does not matter: daemon and widget share a persistent token (token.ts), and
 * the widget's EventSource retries until the daemon answers.
 */

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_DIR } from './paths.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DAEMON_TS = join(REPO, 'packages', 'collector', 'src', 'daemon.ts');
const WIDGET_BIN = join(REPO, 'apps', 'widget', 'src-tauri', 'target', 'release', 'claude-pet-widget');
const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

export type Agent = {
  label: string;
  program: string[];
  /** true = always restart; 'crash' = restart only after an abnormal exit. */
  keepAlive: true | 'crash';
  log: string;
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(a: Agent): string {
  const keepAlive = a.keepAlive === true
    ? '<true/>'
    : '<dict><key>SuccessfulExit</key><false/></dict>';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(a.label)}</string>
  <key>ProgramArguments</key>
  <array>
${a.program.map((p) => `    <string>${esc(p)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${keepAlive}
  <key>ThrottleInterval</key><integer>10</integer>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${esc(a.log)}</string>
  <key>StandardErrorPath</key><string>${esc(a.log)}</string>
</dict>
</plist>
`;
}

/**
 * The `node` on PATH, unresolved: /opt/homebrew/bin/node survives `brew upgrade`, whereas
 * process.execPath points into a versioned Cellar directory that the next upgrade deletes.
 */
function nodeOnPath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'node');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return process.execPath;
}

export function agents(): Agent[] {
  return [
    {
      label: 'dev.r45635.claude-pet.daemon',
      program: [nodeOnPath(), DAEMON_TS],
      keepAlive: true,
      log: join(LOG_DIR, 'daemon.log'),
    },
    {
      label: 'dev.r45635.claude-pet.widget',
      program: [WIDGET_BIN],
      keepAlive: 'crash',
      log: join(LOG_DIR, 'widget.log'),
    },
  ];
}

const domain = (): string => `gui/${process.getuid!()}`;
const plistPath = (label: string): string => join(AGENTS_DIR, `${label}.plist`);

function launchctl(...args: string[]): boolean {
  try {
    execFileSync('launchctl', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function main(argv: string[]): number {
  const mode = argv.find((a) => ['install', 'uninstall', 'status', 'restart'].includes(a)) ?? 'status';
  const dryRun = argv.includes('--dry-run');

  if (mode === 'status') {
    for (const a of agents()) {
      const loaded = launchctl('print', `${domain()}/${a.label}`);
      const installed = existsSync(plistPath(a.label));
      process.stdout.write(`${a.label}: ${installed ? 'installed' : 'not installed'}, ${loaded ? 'loaded' : 'not loaded'}\n`);
    }
    return 0;
  }

  if (mode === 'restart') {
    for (const a of agents()) {
      if (!existsSync(plistPath(a.label))) {
        process.stderr.write(`${a.label} is not installed: npm run autostart -- install\n`);
        return 1;
      }
      if (dryRun) { process.stdout.write(`restart ${a.label}\n`); continue; }
      // -k: kill the running instance first, so a new binary or new code is picked up.
      if (!launchctl('kickstart', '-k', `${domain()}/${a.label}`)) {
        process.stderr.write(`launchctl kickstart failed for ${a.label} — see ${a.log}\n`);
        return 1;
      }
      process.stdout.write(`restarted ${a.label}\n`);
    }
    return 0;
  }

  if (mode === 'install' && !existsSync(WIDGET_BIN)) {
    process.stderr.write(`widget binary missing: ${WIDGET_BIN}\nbuild it first: cd apps/widget && cargo tauri build --no-bundle\n`);
    return 1;
  }

  for (const a of agents()) {
    const file = plistPath(a.label);
    if (dryRun) {
      process.stdout.write(`${mode} ${file}\n${mode === 'install' ? plist(a) : ''}\n`);
      continue;
    }
    // bootout first in both modes: install must replace a stale definition, not stack on it.
    launchctl('bootout', `${domain()}/${a.label}`);
    if (mode === 'uninstall') {
      rmSync(file, { force: true });
      process.stdout.write(`removed ${a.label}\n`);
      continue;
    }
    mkdirSync(AGENTS_DIR, { recursive: true });
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(file, plist(a), { mode: 0o644 });
    if (!launchctl('bootstrap', domain(), file)) {
      process.stderr.write(`launchctl bootstrap failed for ${a.label} — see ${a.log}\n`);
      return 1;
    }
    process.stdout.write(`loaded ${a.label}  (log: ${a.log})\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
