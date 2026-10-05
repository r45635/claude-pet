/**
 * The creature's preferences, as set from its right-click menu. They live in the same
 * ~/.claude-pet/config.json as the hand-tuned engine overrides — one file, one truth:
 *
 *   { "temperament": "zen", "ui": { "size": "large", "showSessions": false, "paused": false },
 *     ...any engine override, which always wins over the temperament preset }
 *
 * A patch from the menu is validated key by key; anything else is refused, so the
 * HTTP route cannot be used to write arbitrary content into the file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isTemperament, mergeConfig, type Temperament } from '@claude-pet/core';
import { CONFIG_FILE } from './paths.ts';

export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];

export const CHAT_MODELS = ['default', 'sonnet', 'haiku'] as const;
export type ChatModel = (typeof CHAT_MODELS)[number];

export type Prefs = {
  temperament: Temperament;
  /** Model for the creature's own Claude (run by the widget). `default` = Claude Code's pick. */
  chatModel: ChatModel;
  size: Size;
  showSessions: boolean;
  paused: boolean;
  /**
   * Read the conversation files (~/.claude/projects) for per-thread activity and real
   * token counts. Off by default: those files hold prompts and answers, and the pet
   * otherwise never opens them. Only line and block types and token counts are kept.
   */
  readTranscripts: boolean;
  /** Load (0-100) at which the creature storms. Effective value: preset or override. */
  stormThreshold: number;
  /** Shortest time a state stays on screen, seconds. Effective value. */
  minStateSeconds: number;
};

/** The settings panel's ranges. The storm ends 10 points below where it starts. */
export const STORM_THRESHOLD = { min: 30, max: 100 } as const;
export const MIN_STATE_SECONDS = { min: 0, max: 30 } as const;
const STORM_EXIT_GAP = 10;

const BASE = mergeConfig({});
export const DEFAULT_PREFS: Prefs = {
  temperament: 'normal',
  chatModel: 'default',
  size: 'medium',
  showSessions: true,
  paused: false,
  readTranscripts: false,
  stormThreshold: BASE.highLoadThreshold,
  minStateSeconds: BASE.minStateMs / 1000,
};

/** A patch: the panel's two numbers may also be null, meaning "back to the default". */
export type PrefsPatch = Partial<Omit<Prefs, 'stormThreshold' | 'minStateSeconds'>> & {
  stormThreshold?: number | null;
  minStateSeconds?: number | null;
};

const inRange = (v: unknown, r: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;

type UserFile = Record<string, unknown> & { ui?: Record<string, unknown> };

export function readUserFile(file = CONFIG_FILE): UserFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function prefsOf(user: UserFile): Prefs {
  const ui = user.ui ?? {};
  const engine = mergeConfig(user);
  return {
    stormThreshold: engine.highLoadThreshold,
    minStateSeconds: engine.minStateMs / 1000,
    temperament: isTemperament(user.temperament) ? user.temperament : DEFAULT_PREFS.temperament,
    chatModel: CHAT_MODELS.includes(ui.chatModel as ChatModel) ? (ui.chatModel as ChatModel) : DEFAULT_PREFS.chatModel,
    size: SIZES.includes(ui.size as Size) ? (ui.size as Size) : DEFAULT_PREFS.size,
    showSessions: typeof ui.showSessions === 'boolean' ? ui.showSessions : DEFAULT_PREFS.showSessions,
    paused: typeof ui.paused === 'boolean' ? ui.paused : DEFAULT_PREFS.paused,
    readTranscripts: typeof ui.readTranscripts === 'boolean' ? ui.readTranscripts : DEFAULT_PREFS.readTranscripts,
  };
}

/** Validate a menu patch. Returns the cleaned patch, or an error naming the bad key. */
export function validatePatch(raw: unknown): PrefsPatch | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'patch must be an object' };
  const out: PrefsPatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'temperament' && isTemperament(value)) out.temperament = value;
    else if (key === 'size' && SIZES.includes(value as Size)) out.size = value as Size;
    else if (key === 'chatModel' && CHAT_MODELS.includes(value as ChatModel)) out.chatModel = value as ChatModel;
    else if (key === 'showSessions' && typeof value === 'boolean') out.showSessions = value;
    else if (key === 'paused' && typeof value === 'boolean') out.paused = value;
    else if (key === 'readTranscripts' && typeof value === 'boolean') out.readTranscripts = value;
    else if (key === 'stormThreshold' && (value === null || (inRange(value, STORM_THRESHOLD) && Number.isInteger(value)))) {
      out.stormThreshold = value;
    }
    else if (key === 'minStateSeconds' && (value === null || inRange(value, MIN_STATE_SECONDS))) {
      out.minStateSeconds = value === null ? null : Math.round(value * 10) / 10;
    }
    else return { error: `invalid key or value: ${key}` };
  }
  return out;
}

/** Fold a validated patch into the user file, keeping every other key untouched. */
export function applyPatch(user: UserFile, patch: PrefsPatch): UserFile {
  const next: UserFile = { ...user, ui: { ...(user.ui ?? {}) } };
  if (patch.temperament !== undefined) next.temperament = patch.temperament;
  if (patch.size !== undefined) next.ui!.size = patch.size;
  if (patch.chatModel !== undefined) next.ui!.chatModel = patch.chatModel;
  if (patch.showSessions !== undefined) next.ui!.showSessions = patch.showSessions;
  if (patch.paused !== undefined) next.ui!.paused = patch.paused;
  if (patch.readTranscripts !== undefined) next.ui!.readTranscripts = patch.readTranscripts;
  // The panel's numbers are engine overrides: like a hand edit, they win over the
  // temperament preset until reset (null), which hands the knob back to the preset.
  if (patch.stormThreshold === null) {
    delete next.highLoadThreshold;
    delete next.highLoadExitThreshold;
  } else if (patch.stormThreshold !== undefined) {
    next.highLoadThreshold = patch.stormThreshold;
    next.highLoadExitThreshold = Math.max(0, patch.stormThreshold - STORM_EXIT_GAP);
  }
  if (patch.minStateSeconds === null) delete next.minStateMs;
  else if (patch.minStateSeconds !== undefined) next.minStateMs = Math.round(patch.minStateSeconds * 1000);
  return next;
}

export function writeUserFile(user: UserFile, file = CONFIG_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(user, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
