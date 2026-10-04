/**
 * The state engine: events + a clock you pass in -> a PetSnapshot.
 *
 * Pure by design. No Date.now(), no file system, no network. That is what makes it
 * testable without mocks and what lets the simulator drive the exact same code path a
 * real session drives.
 */

import type { ChannelName, EngineConfig } from './config.ts';
import { DEFAULT_CONFIG } from './config.ts';
import type { MeterSample, PetEvent, ToolClass } from './events.ts';
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

/**
 * Why the creature storms or is in distress, for the thought bubble. Closed values only:
 * a tool class, an API error enum, a load channel — never text from the session.
 */
export type PetReason =
  | { kind: 'tool_failed'; tool: ToolClass | null }
  | { kind: 'api_error'; code: string | null }
  /** The load channel scoring highest right now. Derived. */
  | { kind: 'storm'; driver: ChannelName };

export type PetSnapshot = {
  state: PetState;
  visual: VisualState;
  /** Set in HIGH_LOAD and ERROR only; null otherwise. */
  reason: PetReason | null;
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
  /**
   * The session the creature is showing: the busiest by load. Load, rates, subagents,
   * the context gauge and `session` all describe this one. null before any event.
   */
  focus: string | null;
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
/** One subagent, as its own small creature shows it. */
export type AgentSummary = {
  /** Claude Code's agent_id, cut to 12 safe characters: opaque. */
  id: string;
  /** Agent type, lowercased (`explore`, `general-purpose`, …); null if unknown. */
  type: string | null;
  /** What this agent is visibly doing, from its own tool events (agent_id). */
  state: PetState;
  /** Set when it shows ERROR: which class of tool failed. */
  reason: PetReason | null;
};

export type SessionSummary = {
  /** First 8 chars of the session UUID: opaque, carries nothing about the user. */
  id: string;
  status: SessionStatus;
  /** ms since this session's current turn started; null outside a turn. */
  turn_ms: number | null;
  /** This session's main thread, resolved on its own events only. */
  state: PetState;
  /** This session's load, 0-100. Derived. */
  load: number;
  /** Its subagents, running or just finished, in start order. */
  agents: AgentSummary[];
  /** Why this session's creature storms or is in distress; null otherwise. */
  reason: PetReason | null;
  /** This session's tool calls per minute, for its storm line. Derived. */
  tool_calls_per_minute: number;
};

/** A subagent, tracked from SubagentStart to SubagentStop by its agent_id. */
type Agent = {
  type: string | null;
  dominant: 'read' | 'write' | 'tool' | null;
  dominantAtMs: number;
  errorMs: number;
  errorTool: ToolClass | null;
  waiting: boolean;
  /** SubagentStop time; the agent stays on screen as DONE for a moment, then goes. */
  doneMs: number;
  /** Its last event, for agentStaleMs. */
  lastMs: number;
  hold: Hold;
};

/** What a creature shows and since when: `minStateMs` keeps it on screen. */
type Hold = { shown: PetState; sinceMs: number };
type SessionSeen = {
  firstMs: number;
  lastMs: number;
  doneMs: number;
  /** Parent pid of the session's hooks; the daemon resolves it to the `claude` process. */
  ppid?: number;
  /** Last network sample for this session's process. */
  net?: { bytesPerSec: number; atMs: number };
};

/**
 * Everything that describes ONE session's activity. Several Claude Code windows share one
 * spool; mixing their reads, writes, gauges and load made the creature flicker between
 * them and storm on the sum of calm sessions. The creature shows the busiest lane.
 */
type Lane = {
  load: LoadState;
  recent: RecentEvent[];
  meter: MeterSample | null;
  dominant: 'read' | 'write' | 'tool' | null;
  dominantAtMs: number;
  /** Any event, status-line samples included: for expiry. */
  lastMs: number;
  /** Hook events only, to break load ties: a status line refreshing on its own timer
   *  must not move the creature from one idle session to another. */
  activeMs: number;
  /** Main-thread error and sleep signals, for this session's own creature. */
  errorMs: number;
  error: PetReason | null;
  idleMs: number;
  previous: PetState;
  hold: Hold;
};

/**
 * A main thread with nothing of its own in flight while its subagents work is waiting on
 * them, not asleep: background agents run long after the turn that launched them.
 */
function delegating(state: PetState, runningAgents: number): PetState {
  return state === 'IDLE' && runningAgents > 0 ? 'TOOL_CALL' : state;
}

/** The load channel scoring highest: what a storm is "about". */
function loudest(channels: Record<ChannelName, number>): ChannelName {
  const names = Object.keys(channels) as ChannelName[];
  return names.reduce((a, b) => (channels[b] > channels[a] ? b : a));
}

/** Load points another session needs above the shown one to take the creature over. */
const FOCUS_MARGIN = 10;

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
  /** Swappable at runtime (menu → daemon → setConfig); state is kept across a swap. */
  config: EngineConfig;

  /** One lane per session id, statusline-only sessions included. */
  #lanes = new Map<string, Lane>();

  /**
   * Open turns, per session. Several Claude Code windows share one spool: a Stop in one
   * must not end the turn of another (observed: a second window's Stop put this one to
   * sleep mid-turn).
   */
  #turns = new Map<string, Turn>();
  #previous: PetState = 'IDLE';
  /** What the single (focus) creature shows, and since when: `minStateMs` holds it. */
  #shownHold: Hold = { shown: 'IDLE', sinceMs: 0 };
  /** Every session seen, for the per-session list. Insertion order = display order. */
  #sessions = new Map<string, SessionSeen>();
  /** Sessions blocked on a permission prompt. */
  #pending = new Set<string>();
  /**
   * Subagents per session, by agent_id: one session ending or idling must not reset
   * another's. Without an agent_id (older Claude Code) a placeholder id is made up.
   */
  #agents = new Map<string, Map<string, Agent>>();
  #anonAgents = 0;

  #lastActivityMs = 0;
  #lastErrorMs = 0;
  #lastError: PetReason | null = null;
  #lastIdleSignalMs = 0;
  #lastMeterMs = 0;


  #netSeen = false;
  #eventsSeen = 0;
  #eventsDropped = 0;
  #sawHookEvent = false;

  #transcriptEnabled = false;
  #tokensPerMinute: number | null = null;

  constructor(nowMs: number, config: EngineConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.#bornMs = nowMs;
  }

  #bornMs: number;
  /** The clock of the snapshot being built. */
  #nowMs = 0;
  /** The session the creature showed last tick. */
  #focusSid: string | null = null;

  #lane(sid: string, atMs: number): Lane {
    let lane = this.#lanes.get(sid);
    if (!lane) {
      lane = { load: createLoadState(atMs), recent: [], meter: null, dominant: null, dominantAtMs: 0, lastMs: atMs,
               activeMs: 0, errorMs: 0, error: null, idleMs: 0, previous: 'IDLE', hold: { shown: 'IDLE', sinceMs: 0 } };
      this.#lanes.set(sid, lane);
    }
    lane.lastMs = Math.max(lane.lastMs, atMs);
    return lane;
  }

  #agent(sid: string, aid: string, type: string | null, atMs: number): Agent {
    let agents = this.#agents.get(sid);
    if (!agents) this.#agents.set(sid, (agents = new Map()));
    let agent = agents.get(aid);
    if (!agent) {
      agent = { type, dominant: null, dominantAtMs: 0, errorMs: 0, errorTool: null, waiting: false, doneMs: 0, lastMs: atMs,
                hold: { shown: 'IDLE', sinceMs: atMs } };
      agents.set(aid, agent);
    }
    if (type && !agent.type) agent.type = type;
    agent.lastMs = Math.max(agent.lastMs, atMs);
    return agent;
  }

  /** Placeholder agents (no agent_id, older Claude Code) cannot be matched: drop them. */
  #forgetAnonymousAgents(sid: string): void {
    const agents = this.#agents.get(sid);
    if (!agents) return;
    for (const id of [...agents.keys()]) if (id.startsWith('~')) agents.delete(id);
    if (agents.size === 0) this.#agents.delete(sid);
  }

  /** Subagents of a session still running (finished ones linger on screen as DONE). */
  #running(sid: string): number {
    let n = 0;
    for (const a of this.#agents.get(sid)?.values() ?? []) {
      if (a.doneMs === 0 && this.#nowMs - a.lastMs <= this.config.agentStaleMs) n += 1;
    }
    return n;
  }

  setConfig(config: EngineConfig): void {
    this.config = config;
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

    const sid = event.sid ?? '';
    const lane = this.#lane(sid, event.tsMs);

    if (event.type === 'METER_SAMPLE') {
      lane.meter = event.meter ?? null;
      this.#lastMeterMs = event.tsMs;
      return; // A gauge never contributes to load.
    }

    this.#sawHookEvent = true;
    lane.activeMs = Math.max(lane.activeMs, event.tsMs);
    ingestLoad(lane.load, event, this.config);

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
      lane.recent.push({ tsMs: event.tsMs, isToolCall: TOOL_TYPES.has(event.type) });
    }

    // What a creature is doing comes from its own events: a subagent's Read makes ITS
    // creature read, not the session's main one (which is waiting on the Agent tool).
    const actor = event.aid && event.type !== 'SUBAGENT_STARTED' && event.type !== 'SUBAGENT_FINISHED'
      ? this.#agent(sid, event.aid, null, event.tsMs)
      : lane;
    const kind = READ_TYPES.has(event.type) ? 'read'
      : WRITE_TYPES.has(event.type) ? 'write'
      : TOOL_TYPES.has(event.type) ? 'tool' : null;
    if (kind) {
      actor.dominant = kind;
      actor.dominantAtMs = event.tsMs;
    }
    if (actor !== lane) {
      const agent = actor as Agent;
      if (ACTIVITY_TYPES.has(event.type)) agent.waiting = false;
      if (event.type === 'ERROR') {
        agent.errorMs = event.tsMs;
        agent.errorTool = event.tool ?? null;
      }
      if (event.type === 'PERMISSION_WAITING') agent.waiting = true;
    } else if (event.type === 'ERROR') {
      lane.errorMs = event.tsMs;
      lane.error = event.scope === 'api'
        ? { kind: 'api_error', code: event.code ?? null }
        : { kind: 'tool_failed', tool: event.tool ?? null };
    }

    switch (event.type) {
      case 'SESSION_STARTED':
        this.#lastIdleSignalMs = 0;
        lane.idleMs = 0;
        break;
      case 'PROMPT_SUBMITTED':
        // A prompt typed mid-turn does not restart the turn.
        if (!this.#turns.has(sid)) this.#turns.set(sid, { startMs: event.tsMs, lastEventMs: event.tsMs });
        // The human typing means no permission dialog is open. Agents with an id stay:
        // background agents keep working while the human chats (they end on their own
        // SubagentStop, or agentStaleMs of silence). Anonymous ones cannot be told
        // apart, so Esc's leftovers are cleared rather than faking a storm forever.
        this.#forgetAnonymousAgents(sid);
        this.#pending.delete(sid);
        this.#lastIdleSignalMs = 0;
        lane.idleMs = 0;
        this.#lastActivityMs = Math.max(this.#lastActivityMs, event.tsMs);
        break;
      case 'TURN_COMPLETED':
        this.#turns.delete(sid);
        this.#pending.delete(sid);
        lane.dominant = null;
        break;
      case 'PERMISSION_WAITING':
        this.#pending.add(sid);
        break;
      case 'PERMISSION_RESOLVED':
        this.#pending.delete(sid);
        break;
      case 'SUBAGENT_STARTED':
        this.#agent(sid, event.aid ?? `~${++this.#anonAgents}`, event.agent ?? null, event.tsMs);
        break;
      case 'SUBAGENT_FINISHED': {
        // By id; without one, the oldest running agent of that type, else the oldest.
        const agents = [...(this.#agents.get(sid) ?? new Map<string, Agent>()).entries()]
          .filter(([, a]) => a.doneMs === 0);
        const match = agents.find(([id]) => id === event.aid)
          ?? agents.find(([, a]) => event.agent !== undefined && a.type === event.agent)
          ?? agents[0];
        if (match) match[1].doneMs = event.tsMs;
        break;
      }
      case 'ERROR':
        this.#lastErrorMs = event.tsMs;
        this.#lastError =
          event.scope === 'api'
            ? { kind: 'api_error', code: event.code ?? null }
            : { kind: 'tool_failed', tool: event.tool ?? null };
        break;
      // Claude Code waiting on a new prompt (idle_prompt, ~60 s) or gone: whatever this
      // session had in flight is over, even when Esc meant no Stop ever came. The global
      // sleep signal only fires once no other session is still in a turn.
      case 'MODEL_IDLE':
      case 'SESSION_ENDED':
        this.#turns.delete(sid);
        this.#pending.delete(sid);
        if (event.type === 'SESSION_ENDED') {
          this.#agents.delete(sid);
          this.#lanes.delete(sid);
        } else {
          this.#forgetAnonymousAgents(sid);
          lane.idleMs = event.tsMs;
        }
        if (this.#turns.size === 0) this.#lastIdleSignalMs = event.tsMs;
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
      pourLoad(this.#lane(sid, nowMs).load, 'generation', (bytesIn / 1000) * this.config.net.perKb);
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
  #work(sid: string, nowMs: number): number {
    const { max, rampMs } = this.config.work;
    const turn = this.#workingTurns(nowMs).find(([id]) => id === sid)?.[1];
    if (!turn) return 0;
    const generating = this.#generating(sid, nowMs);
    return generating === null
      ? max * (1 - Math.exp(-Math.max(0, nowMs - turn.startMs) / rampMs))
      : generating ? max : max * this.config.net.quietWorkFactor;
  }

  #sessionList(nowMs: number, ticks: Map<string, ReturnType<typeof tickLoad>>): SessionSummary[] {
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
      const tick = ticks.get(sid);
      const load = tick?.load ?? 0;
      const state = this.#sessionState(sid, seen, load, turn !== undefined && working.has(turn), nowMs);
      const recent = this.#lanes.get(sid)?.recent ?? [];
      const perMinute = 60_000 / this.config.rateWindowMs;
      out.push({
        id: sid,
        status,
        turn_ms: turn ? Math.max(0, nowMs - turn.startMs) : null,
        state,
        load,
        agents: this.#agentList(sid, nowMs),
        reason: state === 'ERROR' ? (this.#lanes.get(sid)?.error ?? null)
          : state === 'HIGH_LOAD' && tick ? { kind: 'storm', driver: loudest(tick.channels) }
          : null,
        tool_calls_per_minute: Math.round(recent.filter((e) => e.isToolCall).length * perMinute),
      });
    }
    return out;
  }

  /** One session's main creature: the same rules as the focus one, on its own events. */
  #sessionState(sid: string, seen: SessionSeen, load: number, trusted: boolean, nowMs: number): PetState {
    const lane = this.#lanes.get(sid);
    if (!lane) return 'IDLE';
    const generating = trusted ? this.#generating(sid, nowMs) : null;
    const raw = resolveState(
      {
        nowMs,
        load,
        lastActivityMs: lane.activeMs,
        turnActive: trusted,
        permissionPending: this.#pending.has(sid),
        lastErrorMs: lane.errorMs,
        lastDoneMs: this.#turns.has(sid) ? 0 : seen.doneMs,
        lastIdleSignalMs: lane.idleMs,
        dominant: lane.dominant,
        dominantAtMs: lane.dominantAtMs,
        previous: lane.previous,
        generating: generating === true,
        measuredQuiet: generating === false,
      },
      this.config,
    );
    lane.previous = raw;
    return this.#hold(lane.hold, delegating(raw, this.#running(sid)), nowMs);
  }

  /** A session's subagents as their creatures show them; finished ones go after a moment. */
  #agentList(sid: string, nowMs: number): AgentSummary[] {
    const agents = this.#agents.get(sid);
    if (!agents) return [];
    const linger = Math.max(this.config.doneStickyMs, this.config.minStateMs);
    const out: AgentSummary[] = [];
    for (const [id, a] of agents) {
      if ((a.doneMs > 0 && nowMs - a.doneMs >= linger) ||
          (a.doneMs === 0 && nowMs - a.lastMs > this.config.agentStaleMs)) {
        agents.delete(id);
        continue;
      }
      let raw: PetState;
      if (a.doneMs > 0) raw = 'DONE';
      else if (a.errorMs > 0 && nowMs - a.errorMs < this.config.errorStickyMs) raw = 'ERROR';
      else if (a.waiting) raw = 'WAITING';
      else if (a.dominant && nowMs - a.dominantAtMs < this.config.idleAfterMs) {
        raw = a.dominant === 'read' ? 'READING' : a.dominant === 'write' ? 'CODING' : 'TOOL_CALL';
      }
      // Running, no tool in flight: its model is working (the main thread's rule 8).
      else raw = 'THINKING';
      // DONE is final: the hold must not keep a finished agent looking busy.
      const state = raw === 'DONE' ? 'DONE' : this.#hold(a.hold, raw, nowMs);
      if (state === 'DONE') a.hold = { shown: 'DONE', sinceMs: a.doneMs };
      out.push({ id, type: a.type, state,
                 reason: state === 'ERROR' ? { kind: 'tool_failed', tool: a.errorTool } : null });
    }
    if (agents.size === 0) this.#agents.delete(sid);
    return out;
  }

  /**
   * The last turn completed by a session that has not started another. Another window
   * submitting a prompt no longer wipes this one's DONE.
   */
  #lastDone(): number {
    let last = 0;
    for (const [sid, seen] of this.#sessions) {
      if (!this.#turns.has(sid)) last = Math.max(last, seen.doneMs);
    }
    return last;
  }

  /** Keep the state on screen for at least `minStateMs`; see EngineConfig.minStateMs. */
  #hold(hold: Hold, next: PetState, nowMs: number): PetState {
    const shown = hold.shown;
    // Waking up, distress, a question for the human and a storm show at once.
    const free = shown === 'IDLE' || shown === 'WAITING' ||
      next === 'ERROR' || next === 'WAITING' || next === 'HIGH_LOAD';
    if (next !== shown && !free && nowMs - hold.sinceMs < this.config.minStateMs) return shown;
    if (next !== shown) {
      hold.shown = next;
      hold.sinceMs = nowMs;
    }
    return next;
  }

  get #turnActive(): boolean {
    return this.#turns.size > 0;
  }

  snapshot(nowMs: number): PetSnapshot {
    this.#nowMs = nowMs;
    // Tick every lane (they all decay), then follow the busiest: the creature shows one
    // session, the pastilles show them all. Ties go to the most recently active.
    const windowStart = nowMs - this.config.rateWindowMs;
    type Candidate = { sid: string; lane: Lane; work: number; tick: ReturnType<typeof tickLoad> };
    let focus: Candidate | null = null;
    let shown: Candidate | null = null;
    const ticks = new Map<string, ReturnType<typeof tickLoad>>();
    for (const [sid, lane] of this.#lanes) {
      if (nowMs - lane.lastMs > this.config.sessionTtlMs && !this.#turns.has(sid)) {
        this.#lanes.delete(sid);
        continue;
      }
      while (lane.recent.length > 0 && lane.recent[0]!.tsMs < windowStart) lane.recent.shift();
      const work = this.#work(sid, nowMs);
      const tick = tickLoad(lane.load, nowMs, this.#running(sid), this.config, work,
                            this.#turns.has(sid));
      if (!focus || tick.load > focus.tick.load ||
          (tick.load === focus.tick.load && lane.activeMs > focus.lane.activeMs)) {
        focus = { sid, lane, work, tick };
      }
      if (sid === this.#focusSid) shown = { sid, lane, work, tick };
      ticks.set(sid, tick);
    }
    // Hysteresis: two sessions of about the same load would otherwise swap the creature
    // between them on every event. The one shown keeps it until another is clearly busier.
    if (shown && focus && focus.tick.load < shown.tick.load + FOCUS_MARGIN) focus = shown;
    this.#focusSid = focus?.sid ?? null;
    const idleLane = focus ? null : createLoadState(this.#bornMs);
    const { load, confidence, channels } = focus?.tick ?? tickLoad(idleLane!, nowMs, 0, this.config);
    const work = focus?.work ?? 0;
    const lane = focus?.lane;

    const perMinute = 60_000 / this.config.rateWindowMs;
    const recent = lane?.recent ?? [];
    const activityRate = Math.round(recent.length * perMinute);
    const toolRate = Math.round(recent.reduce((acc, e) => acc + (e.isToolCall ? 1 : 0), 0) * perMinute);

    // Streaming is read on the focused session only: another window's stream must not
    // turn this one's reading into thinking.
    const focusTrusted = focus !== null && this.#workingTurns(nowMs).some(([id]) => id === focus!.sid);
    const measured = focusTrusted ? this.#generating(focus!.sid, nowMs) : null;
    const raw = resolveState(
      {
        nowMs,
        load,
        lastActivityMs: this.#lastActivityMs,
        // Only trusted turns: one gone silent (Esc fires no Stop) must not keep it awake.
        turnActive: this.#workingTurns(nowMs).length > 0,
        permissionPending: this.#pending.size > 0,
        lastErrorMs: this.#lastErrorMs,
        lastDoneMs: this.#lastDone(),
        lastIdleSignalMs: this.#lastIdleSignalMs,
        dominant: lane?.dominant ?? null,
        dominantAtMs: lane?.dominantAtMs ?? 0,
        previous: this.#previous,
        generating: measured === true,
        measuredQuiet: measured === false,
      },
      this.config,
    );
    this.#previous = raw;
    let running = 0;
    for (const sid of this.#agents.keys()) running += this.#running(sid);
    const state = this.#hold(this.#shownHold, delegating(raw, running), nowMs);

    const meter = lane?.meter ?? null;
    const contextLoad =
      meter && meter.context_used_pct !== null
        ? Math.round(clamp(meter.context_used_pct, 0, 100))
        : null;

    const tokens =
      meter && (meter.in_tokens !== null || meter.out_tokens !== null)
        ? (meter.in_tokens ?? 0) + (meter.out_tokens ?? 0)
        : null;

    let reason: PetReason | null = null;
    if (state === 'ERROR') reason = this.#lastError;
    if (state === 'HIGH_LOAD') reason = { kind: 'storm', driver: loudest(channels) };

    return {
      state,
      visual: toVisualState(state),
      reason,
      load,
      load_confidence: confidence,
      context_load: contextLoad,
      estimated_activity_rate: activityRate,
      tokens_per_minute: this.#tokensPerMinute,
      tool_calls_per_minute: toolRate,
      active_subagents: focus ? this.#running(focus.sid) : 0,
      sessions: this.#sessionList(nowMs, ticks),
      focus: focus?.sid ?? null,
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
      estimated: ['load', 'estimated_activity_rate', 'tool_calls_per_minute',
                  ...(reason?.kind === 'storm' ? ['reason'] : [])],
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
