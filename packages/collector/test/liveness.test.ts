import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Liveness, systemProbe, type Probe } from '../src/liveness.ts';

/** A fake process table: pid → its command name. */
function table(procs: Record<number, string>): Probe & { procs: Record<number, string> } {
  return {
    procs,
    alive: (pid) => pid in procs,
    isClaude: async (pid) => procs[pid] === 'claude',
  };
}

test('liveness: a session whose claude process exits is reported gone', async () => {
  const probe = table({ 100: 'claude', 200: 'claude' });
  const live = new Liveness(0, probe);
  const targets = [{ sid: 'aaaa1111', ppid: 100, lastMs: 10 }, { sid: 'bbbb2222', ppid: 200, lastMs: 10 }];
  assert.deepEqual(await live.gone(targets), [], 'both alive');
  delete probe.procs[100];
  assert.deepEqual(await live.gone(targets), ['aaaa1111']);
});

test('liveness: a pid that is not a claude process is never judged', async () => {
  // Hooks run through a short-lived shell: the ppid is that shell, alive then gone.
  const probe = table({ 300: 'sh' });
  const live = new Liveness(0, probe);
  const target = [{ sid: 'cccc3333', ppid: 300, lastMs: 10 }];
  assert.deepEqual(await live.gone(target), []);
  delete probe.procs[300];
  assert.deepEqual(await live.gone(target), [], 'the shell exiting says nothing about the session');
});

test('liveness: replayed sessions whose pid is already dead go once ppids are proven direct', async () => {
  const probe = table({ 100: 'claude' });
  const live = new Liveness(5_000, probe);
  const ghost = { sid: 'dead0000', ppid: 999, lastMs: 1_000 };     // from the spool, before startup
  const recent = { sid: 'live0000', ppid: 998, lastMs: 6_000 };    // an event since startup
  assert.deepEqual(await live.gone([ghost, recent]), [], 'nothing proven yet: no guess');
  assert.deepEqual(await live.gone([{ sid: 'aaaa1111', ppid: 100, lastMs: 6_000 }, ghost, recent]), ['dead0000'],
    'a session active since startup is never declared dead on an unproven pid');
});

test('liveness: the system probe sees this process and not a free pid', async () => {
  assert.equal(systemProbe.alive(process.pid), true);
  assert.equal(systemProbe.alive(2 ** 22 + 12345), false);
  assert.equal(await systemProbe.isClaude(process.pid), false);
});
