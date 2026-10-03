#!/usr/bin/env node
/**
 * claude-pet simulator.
 *
 *   node packages/simulator/src/cli.ts --profile heavy --duration 30
 *   node packages/simulator/src/cli.ts --profile error --duration 20 --seed 7 --fast
 *
 * Writes real `PetEvent` lines to the real spool, so the daemon, the state engine and
 * the widget all run their production code path with no "simulation mode" anywhere.
 */

import { serializePetEvent } from '@claude-pet/core';
import { appendRaw, ensureSpool } from '@claude-pet/collector/spool';
import { SPOOL_FILE } from '../../collector/src/paths.ts';
import { generateSession } from './generate.ts';
import { PROFILE_NAMES, type ProfileName } from './profiles.ts';

type Args = {
  profile: ProfileName;
  durationSec: number;
  seed: number;
  fast: boolean;
  out: string;
  stdout: boolean;
};

function usage(message?: string): never {
  if (message) process.stderr.write(`error: ${message}\n\n`);
  process.stderr.write(
    [
      'usage: cli.ts [options]',
      '',
      `  --profile <name>   ${PROFILE_NAMES.join(' | ')}   (default: moderate)`,
      '  --duration <sec>   session length to generate      (default: 30)',
      '  --seed <int>       PRNG seed; same seed = identical output (default: 1)',
      '  --fast             write everything at once instead of in real time',
      '  --out <file>       spool file to append to          (default: ~/.claude-pet/spool/events.jsonl)',
      '  --stdout           print lines instead of writing the spool',
      '',
    ].join('\n'),
  );
  process.exit(message ? 2 : 0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    profile: 'moderate',
    durationSec: 30,
    seed: 1,
    fast: false,
    out: SPOOL_FILE,
    stdout: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--profile':
        if (!value || !(PROFILE_NAMES as readonly string[]).includes(value)) {
          usage(`--profile must be one of ${PROFILE_NAMES.join(', ')}`);
        }
        args.profile = value as ProfileName;
        i += 1;
        break;
      case '--duration':
        if (!value || !Number.isFinite(Number(value))) usage('--duration needs a number');
        args.durationSec = Number(value);
        i += 1;
        break;
      case '--seed':
        if (!value || !Number.isFinite(Number(value))) usage('--seed needs an integer');
        args.seed = Math.trunc(Number(value));
        i += 1;
        break;
      case '--fast':
        args.fast = true;
        break;
      case '--out':
        if (!value) usage('--out needs a path');
        args.out = value;
        i += 1;
        break;
      case '--stdout':
        args.stdout = true;
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        usage(`unknown flag ${flag}`);
    }
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const durationMs = args.durationSec * 1000;

  // `--fast` keeps startMs at 0 so output is byte-identical for a given seed; real-time
  // mode anchors on the wall clock so the daemon sees plausible timestamps.
  const startMs = args.fast ? 0 : Date.now();
  const events = generateSession({
    profile: args.profile,
    durationMs,
    seed: args.seed,
    startMs,
  });

  const write = (line: string): void => {
    if (args.stdout) process.stdout.write(`${line}\n`);
    else appendRaw(line, args.out);
  };

  if (!args.stdout) ensureSpool();

  if (args.fast) {
    for (const event of events) write(serializePetEvent(event));
    process.stderr.write(
      `simulated ${events.length} events (${args.profile}, seed ${args.seed}, fast)\n`,
    );
    return;
  }

  process.stderr.write(
    `simulating ${events.length} events over ${args.durationSec}s (${args.profile}, seed ${args.seed})\n`,
  );

  let previous = startMs;
  for (const event of events) {
    const wait = event.tsMs - previous;
    if (wait > 0) await sleep(wait);
    previous = event.tsMs;
    write(serializePetEvent(event));
  }
  process.stderr.write('done\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`simulator failed: ${String(error)}\n`);
  process.exit(1);
});
