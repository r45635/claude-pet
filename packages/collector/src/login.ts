/**
 * Start at login, on or off — without uninstalling anything. `launchctl disable` keeps the
 * LaunchAgents installed but tells launchd not to load them at the next login; `enable`
 * undoes it. The running daemon and widget are not stopped. Kept apart from autostart.ts
 * so the daemon does not load the installer to flip a switch.
 */

import { execFileSync } from 'node:child_process';

export const LABELS = { daemon: 'dev.r45635.claude-pet.daemon', widget: 'dev.r45635.claude-pet.widget' } as const;

export function launchctlArgs(enabled: boolean, uid: number): string[][] {
  return Object.values(LABELS).map((label) => [enabled ? 'enable' : 'disable', `gui/${uid}/${label}`]);
}

export function setLaunchAtLogin(enabled: boolean): void {
  if (process.platform !== 'darwin' || !process.getuid) return;
  for (const args of launchctlArgs(enabled, process.getuid())) {
    try {
      execFileSync('launchctl', args, { stdio: 'ignore' });
    } catch {
      process.stderr.write(`launch at login: launchctl ${args.join(' ')} failed\n`);
    }
  }
}
