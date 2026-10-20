#!/usr/bin/env node
/**
 * CPU/memory bench for the running widget: the honest companion to the tables in
 * docs/DEVELOPMENT.md ("What it costs") and docs/RISKS.md #6.
 *
 *   node scripts/bench.ts quiet                 # nothing driven; waits for the engine to go idle
 *   node scripts/bench.ts moderate --seconds 60 # drives the simulator while sampling
 *   node scripts/bench.ts heavy                 # same, with subagents
 *
 * It samples `ps` at 1 Hz for the widget process plus its WebKit XPC helpers (attributed
 * by start time: WebKit XPC services spawned within 30 s of the widget), and the daemon.
 * It REFUSES to print numbers when the widget is not running, and it reports how many
 * spool events arrived during the run: a "quiet" run with events in it is contaminated
 * and says so. A number this script did not measure is a number it does not print.
 */

import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SPOOL = join(homedir(), '.claude-pet', 'spool', 'events.jsonl');
const SCENARIOS = ['quiet', 'moderate', 'heavy'] as const;
type Scenario = (typeof SCENARIOS)[number];

type Proc = { pid: number; command: string };
type Sample = { cpu: number; rssKb: number; daemonCpu: number | null };

function usage(message?: string): never {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(`usage: bench.ts <${SCENARIOS.join(' | ')}> [--seconds N]\n`);
  process.exit(message ? 2 : 0);
}

function ps(fields: string, pids?: number[]): string {
  const args = pids ? ['-o', fields, '-p', pids.join(',')] : ['-Ao', fields];
  try {
    return execFileSync('/bin/ps', args, { encoding: 'utf8' });
  } catch {
    return ''; // a listed process died between samples
  }
}

/** Epoch ms a process started, via `ps -o lstart` (fixed-width asctime). */
function startedAt(pid: number): number | null {
  const line = ps('lstart=', [pid]).trim();
  const ms = Date.parse(line);
  return Number.isFinite(ms) ? ms : null;
}

function findWidget(): Proc {
  const rows = ps('pid=,comm=')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /claude-pet-widget$/.test(l));
  if (rows.length === 0) {
    process.stderr.write('bench: the widget is not running — nothing to measure, refusing to guess.\n');
    process.exit(1);
  }
  if (rows.length > 1) {
    process.stderr.write(`bench: ${rows.length} widget processes found; kill the extras first:\n${rows.join('\n')}\n`);
    process.exit(1);
  }
  const [pid, ...comm] = rows[0].split(/\s+/);
  return { pid: Number(pid), command: comm.join(' ') };
}

/** WebKit XPC helpers started alongside the widget. Others (Safari, …) are reported, not counted. */
function findHelpers(widgetStartMs: number): { helpers: Proc[]; foreign: Proc[] } {
  const helpers: Proc[] = [];
  const foreign: Proc[] = [];
  for (const line of ps('pid=,comm=').split('\n')) {
    const m = /^\s*(\d+)\s+(.*com\.apple\.WebKit\.(?:WebContent|GPU|Networking))$/.exec(line);
    if (!m) continue;
    const proc = { pid: Number(m[1]), command: m[2] };
    const started = startedAt(proc.pid);
    if (started !== null && Math.abs(started - widgetStartMs) <= 30_000) helpers.push(proc);
    else foreign.push(proc);
  }
  return { helpers, foreign };
}

function findDaemon(): Proc | null {
  for (const line of ps('pid=,command=').split('\n')) {
    const m = /^\s*(\d+)\s+(.*node.*collector\/src\/daemon\.ts.*)$/.exec(line);
    if (m) return { pid: Number(m[1]), command: 'daemon' };
  }
  return null;
}

function readSample(pids: number[], daemonPid: number | null): Sample {
  let cpu = 0;
  let rssKb = 0;
  for (const line of ps('pcpu=,rss=', pids).split('\n')) {
    const m = /^\s*([\d.]+)\s+(\d+)/.exec(line);
    if (!m) continue;
    cpu += Number(m[1]);
    rssKb += Number(m[2]);
  }
  let daemonCpu: number | null = null;
  if (daemonPid !== null) {
    const m = /^\s*([\d.]+)/.exec(ps('pcpu=', [daemonPid]));
    if (m) daemonCpu = Number(m[1]);
  }
  return { cpu, rssKb, daemonCpu };
}

function spoolLines(): number {
  try {
    statSync(SPOOL);
    return Number(execFileSync('/usr/bin/wc', ['-l', SPOOL], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  } catch {
    return 0;
  }
}

function spoolAgeMs(): number {
  try {
    return Date.now() - statSync(SPOOL).mtimeMs;
  } catch {
    return Infinity;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stats(values: number[]): { avg: number; max: number } {
  const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return { avg, max: Math.max(0, ...values) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scenario = argv[0] as Scenario;
  if (!SCENARIOS.includes(scenario)) usage(`scenario must be one of ${SCENARIOS.join(', ')}`);
  let seconds = 60;
  const sIdx = argv.indexOf('--seconds');
  if (sIdx >= 0) {
    seconds = Number(argv[sIdx + 1]);
    if (!Number.isFinite(seconds) || seconds < 5) usage('--seconds needs a number >= 5');
  }

  const widget = findWidget();
  const widgetStart = startedAt(widget.pid);
  if (widgetStart === null) {
    process.stderr.write('bench: cannot read the widget start time.\n');
    process.exit(1);
  }
  const { helpers, foreign } = findHelpers(widgetStart);
  const daemon = findDaemon();
  const pids = [widget.pid, ...helpers.map((h) => h.pid)];

  process.stdout.write(`measuring (${scenario}, ${seconds}s):\n`);
  process.stdout.write(`  widget  ${widget.pid}  ${widget.command}\n`);
  for (const h of helpers) process.stdout.write(`  helper  ${h.pid}  ${h.command}\n`);
  process.stdout.write(daemon ? `  daemon  ${daemon.pid}\n` : '  daemon  not found (column omitted)\n');
  if (foreign.length > 0) {
    process.stdout.write(`  ⚠ ${foreign.length} WebKit XPC process(es) NOT counted (started elsewhere):\n`);
    for (const f of foreign) process.stdout.write(`      ${f.pid}  ${f.command}\n`);
  }

  // A quiet run only means something once the engine has gone idle (idleAfterMs = 20 s).
  if (scenario === 'quiet') {
    const deadline = Date.now() + 90_000;
    while (spoolAgeMs() < 25_000 && Date.now() < deadline) await sleep(2_000);
    if (spoolAgeMs() < 25_000) {
      process.stdout.write('  ⚠ spool still receiving events after 90 s; quiet run will be contaminated.\n');
    } else {
      await sleep(5_000); // let the last render settle
    }
  }

  const linesBefore = spoolLines();
  let sim: ReturnType<typeof spawn> | null = null;
  let tailSec = 0;
  if (scenario !== 'quiet') {
    sim = spawn(
      process.execPath,
      ['packages/simulator/src/cli.ts', '--profile', scenario, '--duration', String(seconds)],
      { cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'ignore', 'inherit'] },
    );
    tailSec = 10; // keep sampling through DONE and the load decay
  }

  const samples: Sample[] = [];
  for (let i = 0; i < seconds + tailSec; i += 1) {
    samples.push(readSample(pids, daemon?.pid ?? null));
    await sleep(1_000);
  }
  sim?.kill();
  const linesDuring = spoolLines() - linesBefore;

  const cpu = stats(samples.map((s) => s.cpu));
  const rss = stats(samples.map((s) => s.rssKb));
  const daemonSamples = samples.map((s) => s.daemonCpu).filter((v): v is number => v !== null);
  const dcpu = daemonSamples.length > 0 ? stats(daemonSamples) : null;

  process.stdout.write('\n');
  process.stdout.write(`scenario          ${scenario}\n`);
  process.stdout.write(`date              ${new Date().toISOString().slice(0, 10)}\n`);
  process.stdout.write(`samples           ${samples.length} (1 Hz)\n`);
  process.stdout.write(`spool events      ${linesDuring} during the run${scenario === 'quiet' && linesDuring > 0 ? '  ⚠ CONTAMINATED: not a quiet measurement' : ''}\n`);
  process.stdout.write(`widget+XPC CPU    avg ${cpu.avg.toFixed(1)} %   max ${cpu.max.toFixed(1)} %  (of one core)\n`);
  process.stdout.write(`widget+XPC RSS    avg ${(rss.avg / 1024).toFixed(0)} MB   max ${(rss.max / 1024).toFixed(0)} MB\n`);
  if (dcpu) process.stdout.write(`daemon CPU        avg ${dcpu.avg.toFixed(1)} %   max ${dcpu.max.toFixed(1)} %\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`bench failed: ${String(error)}\n`);
  process.exit(1);
});
