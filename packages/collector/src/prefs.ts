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
import { isTemperament, type Temperament } from '@claude-pet/core';
import { CONFIG_FILE } from './paths.ts';

export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];

export type Prefs = {
  temperament: Temperament;
  size: Size;
  showSessions: boolean;
  paused: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  temperament: 'normal',
  size: 'medium',
  showSessions: true,
  paused: false,
};

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
  return {
    temperament: isTemperament(user.temperament) ? user.temperament : DEFAULT_PREFS.temperament,
    size: SIZES.includes(ui.size as Size) ? (ui.size as Size) : DEFAULT_PREFS.size,
    showSessions: typeof ui.showSessions === 'boolean' ? ui.showSessions : DEFAULT_PREFS.showSessions,
    paused: typeof ui.paused === 'boolean' ? ui.paused : DEFAULT_PREFS.paused,
  };
}

/** Validate a menu patch. Returns the cleaned patch, or an error naming the bad key. */
export function validatePatch(raw: unknown): Partial<Prefs> | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'patch must be an object' };
  const out: Partial<Prefs> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'temperament' && isTemperament(value)) out.temperament = value;
    else if (key === 'size' && SIZES.includes(value as Size)) out.size = value as Size;
    else if (key === 'showSessions' && typeof value === 'boolean') out.showSessions = value;
    else if (key === 'paused' && typeof value === 'boolean') out.paused = value;
    else return { error: `invalid key or value: ${key}` };
  }
  return out;
}

/** Fold a validated patch into the user file, keeping every other key untouched. */
export function applyPatch(user: UserFile, patch: Partial<Prefs>): UserFile {
  const next: UserFile = { ...user, ui: { ...(user.ui ?? {}) } };
  if (patch.temperament !== undefined) next.temperament = patch.temperament;
  if (patch.size !== undefined) next.ui!.size = patch.size;
  if (patch.showSessions !== undefined) next.ui!.showSessions = patch.showSessions;
  if (patch.paused !== undefined) next.ui!.paused = patch.paused;
  return next;
}

export function writeUserFile(user: UserFile, file = CONFIG_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(user, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
