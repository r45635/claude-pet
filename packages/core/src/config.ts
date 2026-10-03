/**
 * Tunable constants for the state engine.
 *
 * Everything here is a convention chosen to make a cartoon legible, not a measurement.
 * `config/default.json` at the repo root overrides these at runtime; the shape is the
 * contract, the numbers are not.
 */

export type ChannelName = 'generation' | 'tool' | 'file' | 'agent';

export type ChannelConfig = {
  /** Exponential decay time constant, ms. Larger = the channel remembers longer. */
  tauMs: number;
  /** Saturation constant: reservoir level that maps to ~63/100. */
  k: number;
  /**
   * Hard ceiling on the reservoir, as a multiple of `k`.
   *
   * Without it a long burst accumulates far past `k` and the channel stays deep in
   * saturation long after the session went quiet — measured at 62/100 thirty seconds
   * after the last event. Capping at 3k tops the channel out at ~95 and makes the
   * decay visible immediately.
   */
  capFactor: number;
  /** Share of the blended score when every channel is live. */
  weight: number;
};

export type EngineConfig = {
  channels: Record<ChannelName, ChannelConfig>;
  /** Weight poured into a reservoir per event type. */
  eventWeights: Record<string, number>;
  /** Extra reservoir added per active subagent, per second. */
  subagentGaugePerSec: number;
  /**
   * Exponent of the weighted power mean used to blend the channels.
   *
   * 1 would be an arithmetic mean, which is wrong here: it says a session must max every
   * channel at once to look busy, when in reality the channels alternate within a turn
   * (tools run, *then* output streams). Measured: a heavy session mid-tool-storm scored
   * 62 with p=1 while tool, file and agent were all above 90. p=2 follows the loudest
   * live channel without ignoring the others.
   */
  blendExponent: number;
  /** Asymmetric smoothing of the final score. */
  smoothing: { attack: number; release: number };
  /** `load` at or above this is HIGH_LOAD. */
  highLoadThreshold: number;
  /** How long ERROR stays on screen after the last error, ms. */
  errorStickyMs: number;
  /** How long DONE stays on screen after a turn ends, ms. */
  doneStickyMs: number;
  /** No events for this long (and no turn running) => IDLE, ms. */
  idleAfterMs: number;
  /** Rolling window for the activity-rate figures, ms. */
  rateWindowMs: number;
};

export const DEFAULT_CONFIG: EngineConfig = {
  channels: {
    generation: { tauMs: 5_000, k: 14, weight: 0.3, capFactor: 3 },
    tool: { tauMs: 5_000, k: 6, weight: 0.3, capFactor: 3 },
    file: { tauMs: 6_000, k: 5, weight: 0.2, capFactor: 3 },
    agent: { tauMs: 6_000, k: 2, weight: 0.2, capFactor: 3 },
  },
  eventWeights: {
    OUTPUT_STREAMING: 1,
    MODEL_ACTIVE: 2,
    TOOL_STARTED: 2,
    TOOL_FINISHED: 0.5,
    BASH_STARTED: 3,
    BASH_FINISHED: 1,
    FILE_READ: 1,
    FILE_WRITE: 2,
    SEARCH: 1.5,
    SUBAGENT_STARTED: 4,
    SUBAGENT_FINISHED: 1,
    ERROR: 3,
  },
  subagentGaugePerSec: 1.5,
  blendExponent: 2,
  smoothing: { attack: 0.45, release: 0.12 },
  highLoadThreshold: 75,
  errorStickyMs: 4_000,
  doneStickyMs: 3_000,
  idleAfterMs: 20_000,
  rateWindowMs: 60_000,
};

/** Which reservoir an event type pours into. Absent => contributes no load. */
export const EVENT_CHANNEL: Record<string, ChannelName> = {
  OUTPUT_STREAMING: 'generation',
  MODEL_ACTIVE: 'generation',
  TOOL_STARTED: 'tool',
  TOOL_FINISHED: 'tool',
  BASH_STARTED: 'tool',
  BASH_FINISHED: 'tool',
  ERROR: 'tool',
  FILE_READ: 'file',
  FILE_WRITE: 'file',
  SEARCH: 'file',
  SUBAGENT_STARTED: 'agent',
  SUBAGENT_FINISHED: 'agent',
};

export function mergeConfig(overrides: unknown): EngineConfig {
  if (!overrides || typeof overrides !== 'object') return DEFAULT_CONFIG;
  const o = overrides as Record<string, unknown>;
  const base = DEFAULT_CONFIG;
  const channels = { ...base.channels };
  const oc = o.channels;
  if (oc && typeof oc === 'object') {
    for (const name of Object.keys(channels) as ChannelName[]) {
      const patch = (oc as Record<string, unknown>)[name];
      if (patch && typeof patch === 'object') {
        channels[name] = { ...channels[name], ...(patch as object) };
      }
    }
  }
  return {
    ...base,
    ...(o as object),
    channels,
    eventWeights: { ...base.eventWeights, ...(o.eventWeights as object | undefined) },
    smoothing: { ...base.smoothing, ...(o.smoothing as object | undefined) },
  } as EngineConfig;
}
