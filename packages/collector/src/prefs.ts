/**
 * The creature's preferences and the config file they live in, ~/.claude-pet/config.json:
 *
 *   { "temperament": "zen",
 *     "ui": { "locale": "fr", "size": { "nominalPx": 150, "zoom": 1.2 }, "chat": { "enabled": false }, … },
 *     …any engine override (packages/core/src/config.ts), which always wins over the preset }
 *
 * Every setting is described once, in settings-schema.json — path, type, range, default,
 * who may write it — and everything here is driven by that description. A patch from the
 * menu or the panel is validated key by key; anything else is refused, so the HTTP route
 * cannot write arbitrary content into the file. Hand-written engine overrides go through
 * `sanitizeEngine`: wrong type or out of range is ignored and reported, never used.
 * An unreadable file is never overwritten (ConfigFileError): your hand edits are kept.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, type Temperament } from '@claude-pet/core';
import { CONFIG_FILE } from './paths.ts';
import AVATAR_FORMAT from './avatar-format.json' with { type: 'json' };
import SCHEMA from './settings-schema.json' with { type: 'json' };

export { SCHEMA };

export type Spec = {
  key: string;
  path: string;
  type: 'enum' | 'bool' | 'int' | 'number' | 'id' | 'point';
  values?: string[];
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  default: unknown;
  section: string | null;
  nativeOnly?: boolean;
  nativeOnlyTrue?: boolean;
  doc: string;
};
export const SPECS = SCHEMA.prefs as Spec[];
const SPEC = new Map(SPECS.map((s) => [s.key, s]));

// ---- size: nominal × zoom, kept between min and max ----------------------------------------
export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];
/** The menu's sizes are shortcuts for these nominal sizes. */
export const SIZE_PX: Record<Size, number> = { small: 110, medium: 150, large: 220 };

/** The size actually shown: nominal × zoom, clamped to [min, max] (in either order). */
export function shownPx(nominalPx: number, zoom: number, minPx: number, maxPx: number): number {
  const lo = Math.min(minPx, maxPx);
  const hi = Math.max(minPx, maxPx);
  return Math.round(Math.min(hi, Math.max(lo, nominalPx * zoom)));
}

// ---- the prefs object ----------------------------------------------------------------------
export type Prefs = {
  locale: 'auto' | 'en' | 'fr';
  theme: 'system' | 'light' | 'dark';
  reduceMotion: 'system' | 'on' | 'off';
  launchAtLogin: boolean;
  updatesCheck: boolean;
  updatesAuto: boolean;
  avatar: string;
  nominalPx: number;
  minPx: number;
  maxPx: number;
  zoom: number;
  opacity: number;
  alwaysOnTop: boolean;
  showSessions: boolean;
  temperament: Temperament;
  /** Effective value: the override if any, else the temperament's. */
  stormThreshold: number;
  /** Effective value, seconds. */
  minStateSeconds: number;
  paused: boolean;
  netSensor: boolean;
  readTranscripts: boolean;
  chatEnabled: boolean;
  chatModel: 'default' | 'sonnet' | 'haiku';
  position: { x: number; y: number } | null;
  /** Derived, for the widget: the size shown (nominal × zoom, clamped) … */
  sizePx: number;
  /** … and the menu preset matching the nominal size, or 'custom'. */
  size: Size | 'custom';
};

/** A patch: any setting by key (null = back to its default), plus the menu's `size` preset. */
export type PrefsPatch = Partial<Record<string, unknown>>;

export class ConfigFileError extends Error {}
type UserFile = Record<string, unknown> & { ui?: Record<string, unknown> };

// ---- paths ---------------------------------------------------------------------------------
function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  o[keys.at(-1)!] = value;
}
function deletePath(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  const parents: Record<string, unknown>[] = [obj];
  for (const k of keys.slice(0, -1)) {
    const next = parents.at(-1)![k];
    if (!next || typeof next !== 'object') return;
    parents.push(next as Record<string, unknown>);
  }
  delete parents.at(-1)![keys.at(-1)!];
  // Drop the containers this emptied (ui.size → ui), never the root.
  for (let i = parents.length - 1; i > 0; i -= 1) {
    if (Object.keys(parents[i]).length > 0) break;
    delete parents[i - 1][keys[i - 1]];
  }
}

// ---- values --------------------------------------------------------------------------------
const AVATAR_ID = new RegExp(AVATAR_FORMAT.idPattern);
const roundTo = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(6));

/** The value as stored, if it is valid for the spec (in the spec's own unit), else undefined. */
export function coerce(spec: Spec, value: unknown): unknown {
  switch (spec.type) {
    case 'enum': return spec.values!.includes(value as string) ? value : undefined;
    case 'bool': return typeof value === 'boolean' ? value : undefined;
    case 'id': return typeof value === 'string' && AVATAR_ID.test(value) ? value : undefined;
    case 'int':
      return Number.isInteger(value) && (value as number) >= spec.min! && (value as number) <= spec.max! ? value : undefined;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min! || value > spec.max!) return undefined;
      return spec.step ? roundTo(value, spec.step) : value;
    }
    case 'point': {
      const p = value as { x?: unknown; y?: unknown } | null;
      const ok = (n: unknown) => Number.isInteger(n) && Math.abs(n as number) <= 100_000;
      return p && typeof p === 'object' && ok(p.x) && ok(p.y) ? { x: p.x, y: p.y } : undefined;
    }
  }
}

const stored = (spec: Spec, user: UserFile) => {
  const raw = getPath(user, spec.path);
  return coerce(spec, spec.scale && typeof raw === 'number' ? raw / spec.scale : raw);
};

// ---- the file ------------------------------------------------------------------------------
/**
 * The user file. Missing → {}. Present but not a JSON object → ConfigFileError: the caller
 * must keep the last good config and never write over it (that would lose hand edits).
 */
export function readUserFile(file = CONFIG_FILE): UserFile {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigFileError(`config.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileError('config.json must contain a JSON object');
  }
  return parsed as UserFile;
}

export function writeUserFile(user: UserFile, file = CONFIG_FILE): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(user, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// ---- engine overrides: checked against the schema's ranges ---------------------------------
const ENGINE_RANGES = Object.entries(SCHEMA.engine).filter(([k]) => !k.startsWith('_')) as [string, [number, number]][];
const NOT_ENGINE = new Set(['ui', 'temperament', '_comment']);

function rangeFor(path: string): [number, number] | undefined {
  for (const [pattern, range] of ENGINE_RANGES) {
    const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+')}$`);
    if (re.test(path)) return range;
  }
  return undefined;
}

/**
 * The file with every invalid engine override removed, and why. A key the engine does not
 * know, a value of the wrong type or out of its range is reported and left out — so a typo
 * in a hand edit can never put the creature into a nonsensical state.
 */
export function sanitizeEngine(user: UserFile): { user: UserFile; warnings: string[] } {
  const warnings: string[] = [];
  const out: UserFile = {};
  const walk = (value: unknown, def: unknown, path: string, into: Record<string, unknown>, key: string) => {
    if (def !== null && typeof def === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        warnings.push(`${path}: expected an object — ignored`);
        return;
      }
      const sub: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!(k in (def as Record<string, unknown>))) warnings.push(`${path}.${k}: unknown key — ignored`);
        else walk(v, (def as Record<string, unknown>)[k], `${path}.${k}`, sub, k);
      }
      if (Object.keys(sub).length) into[key] = sub;
      return;
    }
    const range = rangeFor(path);
    if (typeof value !== 'number' || !Number.isFinite(value)) warnings.push(`${path}: expected a number — ignored`);
    else if (range && (value < range[0] || value > range[1])) warnings.push(`${path}: ${value} is outside ${range[0]}–${range[1]} — ignored`);
    else into[key] = value;
  };
  for (const [key, value] of Object.entries(user)) {
    if (NOT_ENGINE.has(key)) out[key] = value;
    else if (!(key in DEFAULT_CONFIG)) warnings.push(`${key}: unknown key — ignored`);
    else walk(value, (DEFAULT_CONFIG as Record<string, unknown>)[key], key, out, key);
  }
  return { user: out, warnings };
}

// ---- prefs from the file -------------------------------------------------------------------
/** Older files: `ui.size: "large"` or `ui.sizePx: 180` become the nominal size. */
function legacyNominal(user: UserFile): number | undefined {
  const ui = user.ui ?? {};
  if (typeof ui.sizePx === 'number' && Number.isInteger(ui.sizePx) && ui.sizePx >= 80 && ui.sizePx <= 300) return ui.sizePx;
  if (typeof ui.size === 'string' && SIZES.includes(ui.size as Size)) return SIZE_PX[ui.size as Size];
  return undefined;
}

export function prefsOf(user: UserFile): Prefs {
  const engine = mergeConfig(user);
  const out: Record<string, unknown> = {};
  for (const spec of SPECS) out[spec.key] = stored(spec, user) ?? spec.default;
  out.nominalPx = stored(SPEC.get('nominalPx')!, user) ?? legacyNominal(user) ?? SPEC.get('nominalPx')!.default;
  out.stormThreshold = engine.highLoadThreshold;
  out.minStateSeconds = engine.minStateMs / 1000;
  const p = out as Prefs;
  p.sizePx = shownPx(p.nominalPx, p.zoom, p.minPx, p.maxPx);
  p.size = SIZES.find((s) => SIZE_PX[s] === p.nominalPx) ?? 'custom';
  return p;
}

export const DEFAULT_PREFS: Prefs = prefsOf({});

// ---- patches -------------------------------------------------------------------------------
/** Validate a patch. Returns the cleaned patch, or an error naming the bad key. */
export function validatePatch(raw: unknown): PrefsPatch | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'patch must be an object' };
  const out: PrefsPatch = {};
  for (const [key, value] of Object.entries(raw)) {
    // Compatibility: the menu's presets, and the size slider of v0.2.
    if (key === 'size' && SIZES.includes(value as Size)) { out.nominalPx = SIZE_PX[value as Size]; continue; }
    const spec = SPEC.get(key === 'sizePx' ? 'nominalPx' : key);
    if (!spec) return { error: `invalid key or value: ${key}` };
    if (value === null) { out[spec.key] = null; continue; }
    const v = coerce(spec, value);
    if (v === undefined) return { error: `invalid key or value: ${key}` };
    out[spec.key] = v;
  }
  return out;
}

const STORM_EXIT_GAP = 10;

/** Fold a validated patch into the user file, keeping every other key untouched. */
export function applyPatch(user: UserFile, patch: PrefsPatch): UserFile {
  const next = structuredClone(user) as UserFile;
  // Older forms of the size (ui.size: "small", ui.sizePx) become ui.size.nominalPx first:
  // writing ui.size.zoom over a string would otherwise drop the size the user had chosen.
  const legacy = legacyNominal(next);
  if (next.ui && (typeof next.ui.size !== 'object' || next.ui.size === null || 'sizePx' in next.ui)) {
    const keep = typeof next.ui.size === 'object' && next.ui.size !== null ? next.ui.size : {};
    delete next.ui.size;
    delete next.ui.sizePx;
    if (legacy !== undefined || Object.keys(keep).length) next.ui.size = { ...(legacy !== undefined ? { nominalPx: legacy } : {}), ...keep };
  }
  for (const [key, value] of Object.entries(patch)) {
    const spec = SPEC.get(key)!;
    if (value === null) {
      deletePath(next, spec.path);
      if (key === 'stormThreshold') delete next.highLoadExitThreshold;
      continue;
    }
    setPath(next, spec.path, spec.scale ? Math.round((value as number) * spec.scale) : value);
    // The storm ends 10 points below where it starts.
    if (key === 'stormThreshold') next.highLoadExitThreshold = Math.max(0, (value as number) - STORM_EXIT_GAP);
  }
  return next;
}
