/**
 * The state engine: events + a clock you pass in -> a PetSnapshot.
 *
 * Pure by design. No Date.now(), no file system, no network. That is what makes it
 * testable without mocks and what lets the simulator drive the exact same code path a
 * real session drives.
 */

import type { EngineConfig } from './config.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { MeterSample, PetEvent } from './events.ts';
import type { LoadState } from './load.ts';
import { clamp, createLoadState, ingestLoad, tickLoad } from './load.ts';
import type { PetState } from './state.ts';
import { resolveState, toVisualState } from './state.ts';
import type { VisualState } from './state.ts';

export type SnapshotSources = {
  hooks: boolean;
  statusline: boolean;
  transcript: boolean;
  otel: boolean;
};

export type PetSnapshot = {
  state: PetState;
  visual: VisualState;
  /** 0-100. Derived. Always listed in `estimated`. */
  load: number;
  /** 0..1 — how much of the weight model was backed by a live signal. */
  load_confidence: number;
  /** 0-100 from the status line, or null when genuinely unknown. */
  context_load: number | null;
  /** Events per minute, measured over a rolling window. */
  estimated_activity_rate: number;
  /** null unless the (opt-in, undocumented) transcript source is enabled. Never faked. */
  tokens_per_minute: number | null;
  tool_calls_per_minute: number;
  active_subagents: number;
  session: {
    tokens: number | null;
    cost_usd: number | null;
    lines_added: number | null;
    lines_removed: number | null;
    context_window: number | null;
  };
  sources: SnapshotSources;
  /** Names the fields in this payload that are derived rather than observed. */
  estimated: string[];
  last_activity_at: string | null;
  updated_at: string;
  /** Debug only; the overlay reads these. */
  debug: {
    channels: Record<string, number>;
    events_seen: number;
    events_dropped: number;
    turn_active: boolean;
  };
};

type RecentEvent = { tsMs: number; isToolCall: boolean };

const READ_TYPES: ReadonlySet<string> = new Set(['FILE_READ', 'SEARCH']);
const WRITE_TYPES: ReadonlySet<string> = new Set(['FILE_WRITE']);
const TOOL_TYPES: ReadonlySet<string> = new Set(['TOOL_STARTED', 'BASH_STARTED']);

/** Types that count as Claude doing something observable. */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'MODEL_ACTIVE',
  'OUTPUT_STREAMING',
  'FILE_READ',
  'FILE_WRITE',
  'SEARCH',
  'TOOL_STARTED',
  'TOOL_FINISHED',
  'BASH_STARTED',
  'BASH_FINISHED',
  'SUBAGENT_STARTED',
  'SUBAGENT_FINISHED',
  'ERROR',
]);

export class Engine {
  readonly config: EngineConfig;

  #load: LoadState;
  #recent: RecentEvent[] = [];
  #meter: MeterSample | null = null;

  #turnActive = false;
  #permissionPending = false;
  #activeSubagents = 0;

  #lastActivityMs = 0;
  #lastErrorMs = 0;
  #lastDoneMs = 0;
  #lastIdleSignalMs = 0;
  #lastMeterMs = 0;

  #dominant: 'read' | 'write' | 'tool' | null = null;
  #dominantAtMs = 0;

  #eventsSeen = 0;
  #eventsDropped = 0;
  #sawHookEvent = false;

  #transcriptEnabled = false;
  #tokensPerMinute: number | null = null;

  constructor(nowMs: number, config: EngineConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.#load = createLoadState(nowMs);
  }

  /** Called by the tailer when a line could not be parsed. Counted, never guessed at. */
  noteDrop(count = 1): void {
    this.#eventsDropped += count;
  }

  /** Enable the opt-in transcript source. Until then `tokens_per_minute` stays null. */
  enableTranscriptSource(enabled: boolean): void {
    this.#transcriptEnabled = enabled;
    if (!enabled) this.#tokensPerMinute = null;
  }

  /** Measured output-token rate from the transcript source, when it is enabled. */
  setTokensPerMinute(value: number | null): void {
    if (!this.#transcriptEnabled) return;
    this.#tokensPerMinute = value;
  }

  ingest(event: PetEvent): void {
    this.#eventsSeen += 1;

    if (event.type === 'METER_SAMPLE') {
      this.#meter = event.meter ?? null;
      this.#lastMeterMs = event.tsMs;
      return; // A gauge never contributes to load.
    }

    this.#sawHookEvent = true;
    ingestLoad(this.#load, event, this.config);

    if (ACTIVITY_TYPES.has(event.type)) {
      this.#lastActivityMs = Math.max(this.#lastActivityMs, event.tsMs);
      this.#recent.push({ tsMs: event.tsMs, isToolCall: TOOL_TYPES.has(event.type) });
    }

    if (READ_TYPES.has(event.type)) {
      this.#dominant = 'read';
      this.#dominantAtMs = event.tsMs;
    } else if (WRITE_TYPES.has(event.type)) {
      this.#dominant = 'write';
      this.#dominantAtMs = event.tsMs;
    } else if (TOOL_TYPES.has(event.type)) {
      this.#dominant = 'tool';
      this.#dominantAtMs = event.tsMs;
    }

    switch (event.type) {
      case 'SESSION_STARTED':
        this.#lastIdleSignalMs = 0;
        break;
      case 'PROMPT_SUBMITTED':
        this.#turnActive = true;
        this.#lastDoneMs = 0;
        this.#lastIdleSignalMs = 0;
        this.#lastActivityMs = Math.max(this.#lastActivityMs, event.tsMs);
        break;
      case 'TURN_COMPLETED':
        this.#turnActive = false;
        this.#permissionPending = false;
        this.#lastDoneMs = event.tsMs;
        this.#dominant = null;
        break;
      case 'PERMISSION_WAITING':
        this.#permissionPending = true;
        break;
      case 'PERMISSION_RESOLVED':
        this.#permissionPending = false;
        break;
      case 'SUBAGENT_STARTED':
        this.#activeSubagents += 1;
        break;
      case 'SUBAGENT_FINISHED':
        this.#activeSubagents = Math.max(0, this.#activeSubagents - 1);
        break;
      case 'ERROR':
        this.#lastErrorMs = event.tsMs;
        break;
      case 'MODEL_IDLE':
        this.#lastIdleSignalMs = event.tsMs;
        break;
      case 'SESSION_ENDED':
        this.#turnActive = false;
        this.#permissionPending = false;
        this.#activeSubagents = 0;
        this.#lastIdleSignalMs = event.tsMs;
        break;
      default:
        break;
    }
  }

  snapshot(nowMs: number): PetSnapshot {
    const { load, confidence, channels } = tickLoad(
      this.#load,
      nowMs,
      this.#activeSubagents,
      this.config,
    );

    const windowStart = nowMs - this.config.rateWindowMs;
    while (this.#recent.length > 0 && this.#recent[0].tsMs < windowStart) {
      this.#recent.shift();
    }
    const perMinute = 60_000 / this.config.rateWindowMs;
    const activityRate = Math.round(this.#recent.length * perMinute);
    const toolRate = Math.round(
      this.#recent.reduce((acc, e) => acc + (e.isToolCall ? 1 : 0), 0) * perMinute,
    );

    const state = resolveState(
      {
        nowMs,
        load,
        lastActivityMs: this.#lastActivityMs,
        turnActive: this.#turnActive,
        permissionPending: this.#permissionPending,
        lastErrorMs: this.#lastErrorMs,
        lastDoneMs: this.#lastDoneMs,
        lastIdleSignalMs: this.#lastIdleSignalMs,
        dominant: this.#dominant,
        dominantAtMs: this.#dominantAtMs,
      },
      this.config,
    );

    const meter = this.#meter;
    const contextLoad =
      meter && meter.context_used_pct !== null
        ? Math.round(clamp(meter.context_used_pct, 0, 100))
        : null;

    const tokens =
      meter && (meter.in_tokens !== null || meter.out_tokens !== null)
        ? (meter.in_tokens ?? 0) + (meter.out_tokens ?? 0)
        : null;

    return {
      state,
      visual: toVisualState(state),
      load,
      load_confidence: confidence,
      context_load: contextLoad,
      estimated_activity_rate: activityRate,
      tokens_per_minute: this.#tokensPerMinute,
      tool_calls_per_minute: toolRate,
      active_subagents: this.#activeSubagents,
      session: {
        tokens,
        cost_usd: meter?.cost_usd ?? null,
        lines_added: meter?.lines_added ?? null,
        lines_removed: meter?.lines_removed ?? null,
        context_window: meter?.context_window ?? null,
      },
      sources: {
        hooks: this.#sawHookEvent,
        statusline: this.#lastMeterMs > 0,
        transcript: this.#transcriptEnabled,
        otel: false,
      },
      estimated: ['load', 'estimated_activity_rate', 'tool_calls_per_minute'],
      last_activity_at:
        this.#lastActivityMs > 0 ? new Date(this.#lastActivityMs).toISOString() : null,
      updated_at: new Date(nowMs).toISOString(),
      debug: {
        channels,
        events_seen: this.#eventsSeen,
        events_dropped: this.#eventsDropped,
        turn_active: this.#turnActive,
      },
    };
  }
}
