/**
 * Phase 1 — the event simulator.
 *
 * Produces a `PetEvent[]` that the rest of the pipeline cannot distinguish from a real
 * session. Deterministic for a given seed, which is what makes the engine tests in
 * Phase 2 meaningful rather than flaky.
 */

import type { MeterSample, PetEvent, PetEventType, ToolClass } from '@claude-pet/core';
import { chance, intBetween, mulberry32, pick, type Rng } from './rng.ts';
import { PROFILES, type Profile, type ProfileName } from './profiles.ts';

export type GenerateOptions = {
  profile: ProfileName;
  /** Wall-clock span to cover, ms. */
  durationMs: number;
  seed?: number;
  /** Epoch ms of the first event. Fixed value => byte-identical output. */
  startMs?: number;
  sid?: string;
  /** Emit a METER_SAMPLE every N ms, as the status line would. 0 disables. */
  meterEveryMs?: number;
};

const TOOL_START: Record<string, PetEventType> = {
  bash: 'BASH_STARTED',
  read: 'FILE_READ',
  notebook: 'FILE_READ',
  search: 'SEARCH',
  fetch: 'SEARCH',
  write: 'FILE_WRITE',
  edit: 'FILE_WRITE',
};

const TOOL_END: Record<string, PetEventType> = { bash: 'BASH_FINISHED' };

const AGENT_TYPES = ['explore', 'plan', 'general-purpose'] as const;
const API_ERROR_CODES = ['rate_limit', 'overloaded', 'server_error'] as const;

class Builder {
  readonly events: PetEvent[] = [];
  #sid: string;

  constructor(sid: string) {
    this.#sid = sid;
  }

  push(tsMs: number, type: PetEventType, extra: Partial<PetEvent> = {}): void {
    this.events.push({
      v: 1,
      ts: new Date(tsMs).toISOString(),
      tsMs,
      type,
      sid: this.#sid,
      n: 1,
      ...extra,
    });
  }
}

function meterAt(elapsedMs: number, toolCalls: number): MeterSample {
  // A plausible ramp, labelled for what it is: a fixture, not a model of real usage.
  const inTokens = 12_000 + Math.round(elapsedMs / 1000) * 420 + toolCalls * 1_100;
  const pct = Math.min(99, Math.round((inTokens / 200_000) * 100));
  return {
    context_used_pct: pct,
    context_window: 200_000,
    in_tokens: inTokens,
    out_tokens: Math.round(inTokens * 0.04),
    cost_usd: Math.round(inTokens * 0.000012 * 1e4) / 1e4,
    api_ms: Math.round(elapsedMs * 0.35),
    wall_ms: elapsedMs,
    lines_added: toolCalls * 7,
    lines_removed: toolCalls * 2,
    rate_5h_pct: Math.min(100, Math.round(elapsedMs / 36_000)),
    rate_5h_resets: null,
    rate_7d_pct: null,
    rate_7d_resets: null,
    effort: 'high',
    model: 'claude-opus-5',
  };
}

/** One action inside a turn. Returns the cursor after it. */
function emitAction(b: Builder, cursor: number, profile: Profile, rng: Rng): number {
  let t = cursor;

  if (chance(rng, profile.subagentChance)) {
    const agent = pick(rng, AGENT_TYPES);
    b.push(t, 'SUBAGENT_STARTED', { agent });
    const life = intBetween(rng, 3_000, 12_000);
    b.push(t + life, 'SUBAGENT_FINISHED', { agent });
    return t + intBetween(rng, profile.gapMs[0], profile.gapMs[1]);
  }

  const parallel = chance(rng, profile.batchChance) ? intBetween(rng, 2, 4) : 1;

  for (let i = 0; i < parallel; i += 1) {
    const tool = pick(rng, profile.tools) as ToolClass;

    if (chance(rng, profile.permissionChance)) {
      b.push(t, 'PERMISSION_WAITING', { tool });
      t += intBetween(rng, 1_500, 5_000);
      b.push(t, 'PERMISSION_RESOLVED', { tool });
    }

    const startType = TOOL_START[tool] ?? 'TOOL_STARTED';
    b.push(t, startType, { tool });

    const duration = intBetween(rng, 120, 2_500);
    if (chance(rng, profile.errorChance)) {
      b.push(t + duration, 'ERROR', { tool, scope: 'tool' });
    } else {
      b.push(t + duration, TOOL_END[tool] ?? 'TOOL_FINISHED', { tool, ms: duration });
    }
    // Parallel calls are staggered by a few ms, as a real batch is.
    t += parallel > 1 ? intBetween(rng, 5, 40) : 0;
  }

  return t + intBetween(rng, profile.gapMs[0], profile.gapMs[1]);
}

export function generateSession(options: GenerateOptions): PetEvent[] {
  const profile = PROFILES[options.profile];
  const rng = mulberry32(options.seed ?? 1);
  const startMs = options.startMs ?? 0;
  const endMs = startMs + options.durationMs;
  const meterEvery = options.meterEveryMs ?? 2_000;
  const b = new Builder(options.sid ?? 'sim00000');

  b.push(startMs, 'SESSION_STARTED');

  let cursor = startMs + 200;
  let toolCalls = 0;

  while (cursor < endMs) {
    b.push(cursor, 'PROMPT_SUBMITTED');
    cursor += intBetween(rng, profile.thinkMs[0], profile.thinkMs[1]);
    b.push(cursor, 'MODEL_ACTIVE');

    const actions = intBetween(rng, profile.actionsPerTurn[0], profile.actionsPerTurn[1]);
    for (let i = 0; i < actions && cursor < endMs; i += 1) {
      cursor = emitAction(b, cursor, profile, rng);
      toolCalls += 1;
    }

    const chunks = intBetween(rng, profile.streamChunks[0], profile.streamChunks[1]);
    for (let i = 0; i < chunks; i += 1) {
      b.push(cursor, 'OUTPUT_STREAMING');
      cursor += intBetween(rng, profile.streamGapMs[0], profile.streamGapMs[1]);
    }

    if (profile.name === 'error' && chance(rng, 0.3)) {
      b.push(cursor, 'ERROR', { scope: 'api', code: pick(rng, API_ERROR_CODES) });
      cursor += 500;
    }

    b.push(cursor, 'TURN_COMPLETED');
    cursor += intBetween(rng, profile.betweenTurnsMs[0], profile.betweenTurnsMs[1]);
  }

  b.push(Math.min(cursor, endMs), 'SESSION_ENDED', { reason: 'other' });

  if (meterEvery > 0) {
    for (let t = startMs + meterEvery; t <= endMs; t += meterEvery) {
      b.push(t, 'METER_SAMPLE', { meter: meterAt(t - startMs, toolCalls) });
    }
  }

  // Events were emitted out of order on purpose (a tool's end is written when its start
  // is). The spool is chronological, so sort — stably, so a seed stays reproducible.
  return b.events
    .map((event, index) => ({ event, index }))
    .sort((a, x) => a.event.tsMs - x.event.tsMs || a.index - x.index)
    .map(({ event }) => event)
    .filter((event) => event.tsMs <= endMs);
}
