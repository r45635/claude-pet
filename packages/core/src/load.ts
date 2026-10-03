/**
 * load_score — a visualization index, not a measurement.
 *
 * Four decaying reservoirs, each saturating independently, blended by weight and then
 * smoothed asymmetrically so the creature startles fast and calms slowly.
 * Algorithm and rationale: docs/LOAD_SCORE.md
 */

import type { ChannelName, EngineConfig } from './config.ts';
import { EVENT_CHANNEL } from './config.ts';
import type { PetEvent } from './events.ts';

const CHANNELS: ChannelName[] = ['generation', 'tool', 'file', 'agent'];

export type LoadState = {
  reservoirs: Record<ChannelName, number>;
  /** A channel is "live" once it has seen at least one event this session. */
  live: Record<ChannelName, boolean>;
  /** Smoothed output, 0-100, unrounded. */
  smoothed: number;
  lastTickMs: number;
};

export type LoadResult = {
  load: number;
  /** Sum of the weights of live channels, 0..1. Low confidence = most signals silent. */
  confidence: number;
  /** Per-channel saturated scores, for the debug overlay. */
  channels: Record<ChannelName, number>;
};

export function createLoadState(nowMs: number): LoadState {
  return {
    reservoirs: { generation: 0, tool: 0, file: 0, agent: 0 },
    live: { generation: false, tool: false, file: false, agent: false },
    smoothed: 0,
    lastTickMs: nowMs,
  };
}

/** Pour an event's weight into its channel. Events with no channel are ignored here. */
export function ingestLoad(state: LoadState, event: PetEvent, config: EngineConfig): void {
  const channel = EVENT_CHANNEL[event.type];
  if (!channel) return;
  const weight = config.eventWeights[event.type];
  if (weight === undefined) return;
  state.reservoirs[channel] += weight * event.n;
  state.live[channel] = true;
}

/**
 * Advance the reservoirs to `nowMs` and produce the blended score.
 *
 * `activeSubagents` is a gauge rather than an impulse: three subagents working quietly is
 * more load than one, even in a second where none of them emits an event.
 */
export function tickLoad(
  state: LoadState,
  nowMs: number,
  activeSubagents: number,
  config: EngineConfig,
): LoadResult {
  const dtMs = Math.max(0, nowMs - state.lastTickMs);
  state.lastTickMs = nowMs;

  if (activeSubagents > 0) {
    state.reservoirs.agent += activeSubagents * config.subagentGaugePerSec * (dtMs / 1000);
    state.live.agent = true;
  }

  const channels = {} as Record<ChannelName, number>;
  for (const name of CHANNELS) {
    const channel = config.channels[name];
    state.reservoirs[name] *= Math.exp(-dtMs / channel.tauMs);
    // Cap before saturating: an uncapped reservoir keeps the channel pinned for tens of
    // seconds after the session went quiet. See ChannelConfig.capFactor.
    const ceiling = channel.k * channel.capFactor;
    if (state.reservoirs[name] > ceiling) state.reservoirs[name] = ceiling;
    // Saturating map: keeps resolution at every intensity instead of pinning at 100.
    channels[name] = 100 * (1 - Math.exp(-state.reservoirs[name] / channel.k));
  }

  // Blend as a weighted power mean over the channels that have ever produced an event.
  //
  // Two separate corrections live here, both of them load-bearing:
  //  - dead channels are excluded and their weight redistributed, so a session with one
  //    unwired signal cannot be capped below 100 (a bug that would look like calm);
  //  - the exponent emphasises the loudest live channel, because the channels alternate
  //    within a turn rather than peaking together. See EngineConfig.blendExponent.
  const p = config.blendExponent;
  let liveWeight = 0;
  let accumulated = 0;
  for (const name of CHANNELS) {
    if (!state.live[name]) continue;
    const weight = config.channels[name].weight;
    liveWeight += weight;
    accumulated += weight * Math.pow(channels[name], p);
  }
  const raw = liveWeight > 0 ? Math.pow(accumulated / liveWeight, 1 / p) : 0;

  const alpha = raw > state.smoothed ? config.smoothing.attack : config.smoothing.release;
  state.smoothed += alpha * (raw - state.smoothed);

  return {
    load: Math.round(clamp(state.smoothed, 0, 100)),
    confidence: Math.round(clamp(liveWeight, 0, 1) * 100) / 100,
    channels,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
