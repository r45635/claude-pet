import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS, planInstall, planUninstall, type Settings } from '../src/install.ts';

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'install.ts');

/** The shape of a real settings.json: two memory-hub hooks that must survive untouched. */
const HUB: Settings = {
  model: 'opus',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/memory-hub-sync.sh', timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/memory-hub-autopush.sh', timeout: 45 }] }],
  },
};

test('install: merges beside existing hooks and leaves them intact', () => {
  const { settings, changes } = planInstall(HUB, '/opt/pet/bin');
  assert.equal(changes.length, HOOK_EVENTS.length + 1);
  for (const event of HOOK_EVENTS) {
    const cmds = settings.hooks![event].flatMap((g) => g.hooks.map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes('claude-pet-hook.sh')), `missing on ${event}`);
  }
  assert.deepEqual(settings.hooks!.SessionStart[0], HUB.hooks!.SessionStart[0]);
  assert.deepEqual(settings.hooks!.Stop[0], HUB.hooks!.Stop[0]);
  assert.equal(settings.model, 'opus');
  assert.ok(settings.statusLine!.command.includes('claude-pet-statusline.sh'));
});

test('install: does not mutate its input', () => {
  const copy = structuredClone(HUB);
  planInstall(HUB);
  assert.deepEqual(HUB, copy);
});

test('install: is idempotent', () => {
  const once = planInstall(HUB).settings;
  const twice = planInstall(once);
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(twice.settings, once);
});

test('install: a foreign statusLine is never overwritten', () => {
  const foreign: Settings = { ...HUB, statusLine: { type: 'command', command: 'my-own-line.sh' } };
  const { settings, warnings } = planInstall(foreign);
  assert.equal(settings.statusLine!.command, 'my-own-line.sh');
  assert.equal(warnings.length, 1);
});

test('install → uninstall is a semantic no-op', () => {
  const round = planUninstall(planInstall(HUB).settings);
  assert.deepEqual(round.settings, HUB);
  assert.equal(round.changes.length, HOOK_EVENTS.length + 1);
});

test('uninstall: on an empty file removes nothing and keeps a foreign statusLine', () => {
  const foreign: Settings = { statusLine: { type: 'command', command: 'mine.sh' } };
  const { settings, changes } = planUninstall(foreign);
  assert.deepEqual(changes, []);
  assert.deepEqual(settings, foreign);
});

test('cli: --dry-run writes nothing; a real run backs up then writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-install-'));
  const file = join(dir, 'settings.json');
  const original = `${JSON.stringify(HUB, null, 2)}\n`;
  writeFileSync(file, original);
  const env = { ...process.env, CLAUDE_PET_HOME: join(dir, 'pet') };

  execFileSync('node', [INSTALL, 'install', '--dry-run', '--settings', file], { env });
  assert.equal(readFileSync(file, 'utf8'), original, 'dry run must not touch the file');

  execFileSync('node', [INSTALL, 'install', '--settings', file], { env });
  const backups = readdirSync(join(dir, 'pet', 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, 'pet', 'backups', backups[0]), 'utf8'), original);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse);

  execFileSync('node', [INSTALL, 'uninstall', '--settings', file], { env });
  assert.equal(readFileSync(file, 'utf8'), original, 'uninstall must restore the file byte for byte');
});

test('install: re-pointed at another copy of the scripts, rewrites our entries in place', () => {
  const first = planInstall(HUB, '/repo/packages/collector/bin').settings;
  const { settings, changes } = planInstall(first, '/home/.claude-pet/app/hooks');
  assert.equal(changes.length, HOOK_EVENTS.length + 1);
  assert.ok(changes.every((c) => c.startsWith('~ ')));
  for (const event of HOOK_EVENTS) {
    const ours = settings.hooks![event].flatMap((g) => g.hooks).filter((h) => h.command.includes('claude-pet-hook.sh'));
    assert.equal(ours.length, 1, event);
    assert.ok(ours[0].command.includes('/home/.claude-pet/app/hooks/'), event);
  }
  assert.ok(settings.statusLine!.command.includes('/home/.claude-pet/app/hooks/'));
  assert.deepEqual(settings.hooks!.SessionStart[0], HUB.hooks!.SessionStart[0]);
  assert.equal(planInstall(settings, '/home/.claude-pet/app/hooks').changes.length, 0);
});
