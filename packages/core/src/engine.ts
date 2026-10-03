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
import { clamp, createLoadState, ingestLoad, pourLoad, tickLoad } from './load.ts';
import type { PetState } from './state.ts';
import { resolveState, toVisualState } from './state.ts';
import type { VisualState } from './state.ts';

export type SnapshotSources = {
  hooks: boolean;
  /** The daemon's network sensor has delivered at least one sample. */
  net?: boolean;
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
  /** One entry per live Claude Code session on this machine; the creature shows the busiest. */
  sessions: SessionSummary[];
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
type Turn = { startMs: number; lastEventMs: number };

/** One Claude Code session, as the per-session pastilles show it. */
export type SessionStatus = 'thinking' | 'working' | 'waiting' | 'done' | 'idle';
export type SessionSummary = {
  /** First 8 chars of the session UUID: opaque, carries nothing about the user. */
  id: string;
  status: SessionStatus;
  /** ms since this session's current turn started; null outside a turn. */
  turn_ms: number | null;
};
type SessionSeen = {
  firstMs: number;
  lastMs: number;
  doneMs: number;
  /** Parent pid of the session's hooks; the daemon resolves it to the `claude` process. */
  ppid?: number;
  /** Last network sample for this session's process. */
  net?: { bytesPerSec: number; atMs: number };
};

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

  /**
   * Open turns, per session. Several Claude Code windows share one spool: a Stop in one
   * must not end the turn of another (observed: a second window's Stop put this one to
   * sleep mid-turn).
   */
  #turns = new Map<string, Turn>();
  #previous: PetState = 'IDLE';
  /** Every session seen, for the per-session list. Insertion order = display order. */
  #sessions = new Map<string, SessionSeen>();
  /** Sessions blocked on a permission prompt. */
  #pending = new Set<string>();
  #activeSubagents = 0;

  #lastActivityMs = 0;
  #lastErrorMs = 0;
  #lastDoneMs = 0;
  #lastIdleSignalMs = 0;
  #lastMeterMs = 0;

  #dominant: 'read' | 'write' | 'tool' | null = null;
  #dominantAtMs = 0;

  #netSeen = false;
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

    const sid = event.sid ?? '';
    const seen = this.#sessions.get(sid);
    if (seen) seen.lastMs = Math.max(seen.lastMs, event.tsMs);
    else this.#sessions.set(sid, { firstMs: event.tsMs, lastMs: event.tsMs, doneMs: 0 });
    if (event.ppid) this.#sessions.get(sid)!.ppid = event.ppid;
    if (event.type === 'TURN_COMPLETED') this.#sessions.get(sid)!.doneMs = event.tsMs;
    if (event.type === 'SESSION_ENDED') this.#sessions.delete(sid);
    const turn = this.#turns.get(sid);
    if (turn) turn.lastEventMs = Math.max(turn.lastEventMs, event.tsMs);
    // No hook says "permission granted": the session doing anything again is the proof.
    if (this.#pending.has(sid) && ACTIVITY_TYPES.has(event.type)) this.#pending.delete(sid);

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
        // A prompt typed mid-turn does not restart the turn.
        if (!this.#turns.has(sid)) this.#turns.set(sid, { startMs: event.tsMs, lastEventMs: event.tsMs });
        this.#lastDoneMs = 0;
        this.#lastIdleSignalMs = 0;
        this.#lastActivityMs = Math.max(this.#lastActivityMs, event.tsMs);
        break;
      case 'TURN_COMPLETED':
        this.#turns.delete(sid);
        this.#pending.delete(sid);
        this.#lastDoneMs = event.tsMs;
        this.#dominant = null;
        break;
      case 'PERMISSION_WAITING':
        this.#pending.add(sid);
        break;
      case 'PERMISSION_RESOLVED':
        this.#pending.delete(sid);
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
        this.#turns.delete(sid);
        this.#pending.delete(sid);
        this.#activeSubagents = 0;
        this.#lastIdleSignalMs = event.tsMs;
        break;
      default:
        break;
    }
  }

  /** Sessions with an open turn and a known hook parent pid — what the net sensor samples. */
  sessionsToSample(): { sid: string; ppid: number }[] {
    const out: { sid: string; ppid: number }[] = [];
    for (const sid of this.#turns.keys()) {
      const ppid = this.#sessions.get(sid)?.ppid;
      if (ppid) out.push({ sid, ppid });
    }
    return out;
  }

  /**
   * A network sample for a session's `claude` process: `bytesIn` received over `spanMs`.
   * Inbound bytes are the model streaming; they feed the generation channel and mark the
   * session as generating while the sample is fresh.
   */
  ingestNet(sid: string, bytesIn: number, spanMs: number, nowMs: number): void {
    const seen = this.#sessions.get(sid);
    if (!seen || !(spanMs > 0)) return;
    const bytesPerSec = Math.max(0, bytesIn) / (spanMs / 1000);
    seen.net = { bytesPerSec, atMs: nowMs };
    this.#netSeen = true;
    if (bytesPerSec >= this.config.net.activeBytesPerSec) {
      pourLoad(this.#load, 'generation', (bytesIn / 1000) * this.config.net.perKb);
      seen.lastMs = Math.max(seen.lastMs, nowMs);
      const turn = this.#turns.get(sid);
      if (turn) turn.lastEventMs = Math.max(turn.lastEventMs, nowMs);
    }
  }

  /** null = no fresh measurement for this session; else whether its model is streaming. */
  #generating(sid: string, nowMs: number): boolean | null {
    const net = this.#sessions.get(sid)?.net;
    if (!net || nowMs - net.atMs > this.config.net.freshMs) return null;
    return net.bytesPerSec >= this.config.net.activeBytesPerSec;
  }

  /** Turns that are running and trusted: not blocked on the user, not gone silent. */
  #workingTurns(nowMs: number): [string, Turn][] {
    const out: [string, Turn][] = [];
    for (const [sid, turn] of this.#turns) {
      if (this.#pending.has(sid)) continue;
      // A measured session is trusted for as long as its process streams; only an
      // unmeasured one falls back to "no event for staleAfterMs = forget the turn".
      if (this.#generating(sid, nowMs) === null &&
          nowMs - turn.lastEventMs > this.config.work.staleAfterMs) continue;
      out.push([sid, turn]);
    }
    return out;
  }

  /**
   * The turn-running gauge, 0-100: the busiest session's. Measured sessions use the
   * network: full while streaming, reduced while a tool runs. Unmeasured ones fall back
   * to a ramp on turn duration. See EngineConfig.work / EngineConfig.net.
   */
  #work(nowMs: number): number {
    const { max, rampMs } = this.config.work;
    let work = 0;
    for (const [sid, turn] of this.#workingTurns(nowMs)) {
      const generating = this.#generating(sid, nowMs);
      const value = generating === null
        ? max * (1 - Math.exp(-Math.max(0, nowMs - turn.startMs) / rampMs))
        : generating ? max : max * this.config.net.quietWorkFactor;
      work = Math.max(work, value);
    }
    return work;
  }

  #sessionList(nowMs: number): SessionSummary[] {
    const working = new Set(this.#workingTurns(nowMs).map(([, turn]) => turn));
    const out: SessionSummary[] = [];
    for (const [sid, seen] of this.#sessions) {
      if (nowMs - seen.lastMs > this.config.sessionTtlMs) {
        this.#sessions.delete(sid);
        continue;
      }
      const turn = this.#turns.get(sid);
      let status: SessionStatus = 'idle';
      if (this.#pending.has(sid)) status = 'waiting';
      else if (turn && working.has(turn)) {
        status = this.#generating(sid, nowMs) ? 'thinking' : 'working';
      }
      else if (seen.doneMs > 0 && nowMs - seen.doneMs < this.config.doneStickyMs) status = 'done';
      out.push({ id: sid, status, turn_ms: turn ? Math.max(0, nowMs - turn.startMs) : null });
    }
    return out;
  }

  get #turnActive(): boolean {
    return this.#turns.size > 0;
  }

  snapshot(nowMs: number): PetSnapshot {
    const work = this.#work(nowMs);
    const { load, confidence, channels } = tickLoad(
      this.#load,
      nowMs,
      this.#activeSubagents,
      this.config,
      work,
      this.#turnActive,
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

    const measured = this.#workingTurns(nowMs).map(([sid]) => this.#generating(sid, nowMs));
    const state = resolveState(
      {
        nowMs,
        load,
        lastActivityMs: this.#lastActivityMs,
        turnActive: this.#turnActive,
        permissionPending: this.#pending.size > 0,
        lastErrorMs: this.#lastErrorMs,
        lastDoneMs: this.#lastDoneMs,
        lastIdleSignalMs: this.#lastIdleSignalMs,
        dominant: this.#dominant,
        dominantAtMs: this.#dominantAtMs,
        previous: this.#previous,
        generating: measured.includes(true),
        measuredQuiet: measured.length > 0 && measured.every((g) => g === false),
      },
      this.config,
    );
    this.#previous = state;

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
      sessions: this.#sessionList(nowMs),
      session: {
        tokens,
        cost_usd: meter?.cost_usd ?? null,
        lines_added: meter?.lines_added ?? null,
        lines_removed: meter?.lines_removed ?? null,
        context_window: meter?.context_window ?? null,
      },
      sources: {
        hooks: this.#sawHookEvent,
        net: this.#netSeen,
        statusline: this.#lastMeterMs > 0,
        transcript: this.#transcriptEnabled,
        otel: false,
      },
      estimated: ['load', 'estimated_activity_rate', 'tool_calls_per_minute'],
      last_activity_at:
        this.#lastActivityMs > 0 ? new Date(this.#lastActivityMs).toISOString() : null,
      updated_at: new Date(nowMs).toISOString(),
      debug: {
        channels: { ...channels, work: Math.round(work) },
        events_seen: this.#eventsSeen,
        events_dropped: this.#eventsDropped,
        turn_active: this.#turnActive,
      },
    };
  }
}
