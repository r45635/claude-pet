/**
 * The .claudepet avatar format, for the creator tooling (`npm run avatar -- validate|pack`).
 * The rules themselves live in avatar-format.json, shared with the widget's importer
 * (apps/widget/src-tauri/src/avatars.rs), so the two can never disagree.
 *
 * An avatar is untrusted content: everything here is checked by structure (ids, file
 * names, sizes, magic bytes), never trusted by name. See docs/AVATARS.md.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import FORMAT from './avatar-format.json' with { type: 'json' };

export { FORMAT };
export type Kind = 'images' | 'svg';
/** One motion: a keyframes binding with its timing, scale and (for enters) play count. */
export type MotionSpec = {
  target?: string;
  keyframes?: string | null;
  dur?: number | 'auto';
  ease?: string | number[];
  amp?: number;
  count?: number;
};
export type Animations = {
  profile?: string;
  states?: Record<string, MotionSpec & { enter?: MotionSpec; fallback?: string }>;
};
export type Manifest = {
  format: 1;
  id: string;
  name: string;
  author?: string;
  version?: string;
  license?: string;
  kind: Kind;
  states?: Record<string, string>;
  svg?: string;
  css?: string;
  animations?: Animations;
  anchors?: { feet?: [number, number]; why?: [number, number] };
  hitbox?: { cx: number; cy: number; rx: number; ry: number };
};
export type Report = { manifest: Manifest | null; files: string[]; errors: string[]; warnings: string[] };

const ID = new RegExp(FORMAT.idPattern);
const STATE_KEYS = new Set([...FORMAT.states, 'ACTIVE']);
/** Flat file names only: no directory, no dot-file, a known extension. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const num = (v: unknown, lo = -40, hi = 200): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const pair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);

/** Check a parsed manifest; returns the referenced files. */
export function checkManifest(raw: unknown, errors: string[]): { manifest: Manifest | null; files: string[] } {
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    errors.push('manifest.json must be a JSON object');
    return { manifest: null, files: [] };
  }
  if (m.format !== FORMAT.format) errors.push(`"format" must be ${FORMAT.format}`);
  if (typeof m.id !== 'string' || !ID.test(m.id)) errors.push(`"id" must match ${FORMAT.idPattern}`);
  else if (FORMAT.builtin.includes(m.id)) errors.push(`"id" "${m.id}" is reserved for a built-in avatar`);
  if (!str(m.name, 60)) errors.push('"name" is required (1-60 characters)');
  if (m.author !== undefined && !str(m.author, 60)) errors.push('"author" must be 1-60 characters');
  if (m.version !== undefined && !str(m.version, 20)) errors.push('"version" must be 1-20 characters');
  if (m.license !== undefined && !str(m.license, 40)) errors.push('"license" must be 1-40 characters (an SPDX identifier, e.g. "MIT")');

  const files: string[] = [];
  const fileRef = (field: string, name: unknown, exts: string[]) => {
    if (typeof name !== 'string' || !FILE.test(name) || name.includes('..')) {
      errors.push(`${field}: "${String(name)}" is not a plain file name`);
      return;
    }
    if (!exts.includes(extname(name).slice(1).toLowerCase())) {
      errors.push(`${field}: "${name}" must be one of .${exts.join(', .')}`);
      return;
    }
    if (!files.includes(name)) files.push(name);
  };

  if (m.kind === 'images') {
    const states = m.states as Record<string, unknown> | undefined;
    if (!states || typeof states !== 'object' || Array.isArray(states)) {
      errors.push('"states" is required for kind "images"');
    } else {
      if (!('IDLE' in states)) errors.push('"states.IDLE" is required: every state falls back to it');
      for (const [state, file] of Object.entries(states)) {
        if (!STATE_KEYS.has(state)) errors.push(`"states.${state}": unknown state (${[...STATE_KEYS].join(', ')})`);
        else fileRef(`states.${state}`, file, Object.keys(FORMAT.imageTypes));
      }
    }
  } else if (m.kind === 'svg') {
    fileRef('svg', m.svg, ['svg']);
  } else {
    errors.push('"kind" must be "images" or "svg"');
  }
  // Both kinds may ship a stylesheet: it is how pictures get motion too.
  if (m.css !== undefined) fileRef('css', m.css, ['css']);
  if (m.animations !== undefined) checkAnimations(m.animations, errors);

  const anchors = m.anchors as Record<string, unknown> | undefined;
  if (anchors !== undefined) {
    if (!anchors || typeof anchors !== 'object') errors.push('"anchors" must be an object');
    else {
      if (anchors.feet !== undefined && !pair(anchors.feet)) errors.push('"anchors.feet" must be [x, y] in the 160×160 box');
      if (anchors.why !== undefined && !pair(anchors.why)) errors.push('"anchors.why" must be [x, y] in the 160×160 box');
    }
  }
  const h = m.hitbox as Record<string, unknown> | undefined;
  if (h !== undefined && !(h && num(h.cx) && num(h.cy) && num(h.rx, 1, 120) && num(h.ry, 1, 120))) {
    errors.push('"hitbox" must be {cx, cy, rx, ry} in the 160×160 box');
  }
  return { manifest: errors.length ? null : (m as Manifest), files };
}

const A = FORMAT.animations;
const KF = new RegExp(A.keyframePattern);

/** One motion spec of the manifest's `animations` section, strictly. */
function checkMotion(spec: unknown, where: string, enter: boolean, errors: string[]): void {
  const s = spec as Record<string, unknown>;
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  const allowed = enter
    ? ['target', 'keyframes', 'dur', 'ease', 'amp', 'count']
    : ['target', 'keyframes', 'dur', 'ease', 'amp', 'enter', 'fallback'];
  for (const key of Object.keys(s)) {
    if (!allowed.includes(key)) errors.push(`${where}.${key}: unknown key`);
  }
  if (s.target !== undefined && !A.targets.includes(s.target as string)) {
    errors.push(`${where}.target: must be one of ${A.targets.join(', ')}`);
  }
  if (s.keyframes !== undefined && s.keyframes !== null
      && (typeof s.keyframes !== 'string' || !KF.test(s.keyframes))) {
    errors.push(`${where}.keyframes: must match ${A.keyframePattern} (or null for no loop)`);
  }
  if (enter && s.keyframes === null) errors.push(`${where}.keyframes: an enter needs a keyframes name`);
  if (s.dur !== undefined && s.dur !== 'auto'
      && !(typeof s.dur === 'number' && Number.isInteger(s.dur) && s.dur >= A.durMs[0] && s.dur <= A.durMs[1])) {
    errors.push(`${where}.dur: "auto" or whole milliseconds ${A.durMs[0]}-${A.durMs[1]}`);
  }
  if (s.ease !== undefined && !A.easings.includes(s.ease as string)
      && !(Array.isArray(s.ease) && s.ease.length === 4
           && s.ease.every((n) => typeof n === 'number' && n >= A.bezierRange[0] && n <= A.bezierRange[1]))) {
    errors.push(`${where}.ease: a keyword (${A.easings.join(', ')}) or 4 cubic-bezier numbers in [${A.bezierRange}]`);
  }
  if (s.amp !== undefined && !(typeof s.amp === 'number' && s.amp >= A.ampRange[0] && s.amp <= A.ampRange[1])) {
    errors.push(`${where}.amp: a number in [${A.ampRange}]`);
  }
  if (s.count !== undefined && !(typeof s.count === 'number' && Number.isInteger(s.count) && s.count >= 1 && s.count <= A.maxCount)) {
    errors.push(`${where}.count: a whole number 1-${A.maxCount}`);
  }
}

/** The manifest's optional `animations` section (docs/AVATARS.md). Strict: it is new
 *  surface on an untrusted package, so unknown keys are errors, not extensions. */
export function checkAnimations(raw: unknown, errors: string[]): void {
  const a = raw as Record<string, unknown>;
  if (!a || typeof a !== 'object' || Array.isArray(a)) {
    errors.push('"animations" must be an object');
    return;
  }
  for (const key of Object.keys(a)) {
    if (!['profile', 'states'].includes(key)) errors.push(`animations.${key}: unknown key`);
  }
  if (a.profile !== undefined && !A.profiles.includes(a.profile as string)) {
    errors.push(`animations.profile: must be one of ${A.profiles.join(', ')}`);
  }
  if (a.states === undefined) return;
  const states = a.states as Record<string, unknown>;
  if (!states || typeof states !== 'object' || Array.isArray(states)) {
    errors.push('animations.states: must be an object');
    return;
  }
  for (const [state, spec] of Object.entries(states)) {
    if (!(FORMAT.states as string[]).includes(state)) {
      errors.push(`animations.states.${state}: unknown state`);
      continue;
    }
    const where = `animations.states.${state}`;
    const s = spec as Record<string, unknown>;
    if (s && typeof s === 'object' && typeof s.fallback === 'string') {
      if (!(s.fallback in states)) errors.push(`${where}.fallback: "${s.fallback}" is not defined in animations.states`);
      if (Object.keys(s).length > 1) errors.push(`${where}: a fallback entry carries nothing else`);
      continue;
    }
    checkMotion(spec, where, false, errors);
    if (s && typeof s === 'object' && s.enter !== undefined) checkMotion(s.enter, `${where}.enter`, true, errors);
  }
}

/** The keyframes names a stylesheet defines — same scan as the page's scoper. */
export function cssKeyframeNames(css: string): Set<string> {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...text.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
}

/** The real type of a file from its first bytes, never from its name. */
export function sniff(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i];
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (b(0) === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

/** An animated image keeps the CPU busy even while the creature sleeps. */
export function isAnimated(type: string, bytes: Uint8Array): boolean {
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (type === 'png') return text(0, Math.min(bytes.length, 4096)).includes('acTL');
  if (type === 'webp') return text(0, Math.min(bytes.length, 64)).includes('ANIM');
  if (type === 'gif') {
    // More than one image descriptor (0x2C) after a graphic control extension = frames.
    let frames = 0;
    for (let i = 13; i < bytes.length - 1 && frames < 2; i += 1) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9) frames += 1;
    }
    return frames > 1;
  }
  return false;
}

/** Validate an avatar folder (the unpacked form a creator works in). */
export function validateDir(dir: string): Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  let raw: unknown;
  try {
    const path = join(dir, 'manifest.json');
    if (statSync(path).size > FORMAT.limits.manifestBytes) throw new Error('manifest.json is too large');
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { manifest: null, files: [], errors: [`manifest.json: ${(err as Error).message}`], warnings };
  }
  const { manifest, files } = checkManifest(raw, errors);
  if (!manifest) return { manifest, files, errors, warnings };

  const present = new Set(readdirSync(dir));
  if (files.length + 1 > FORMAT.limits.files) errors.push(`more than ${FORMAT.limits.files} files`);
  let total = 0;
  let cssText = '';
  for (const name of files) {
    if (!present.has(name)) {
      errors.push(`${name}: referenced but missing`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    total += bytes.length;
    if (bytes.length > FORMAT.limits.fileBytes) errors.push(`${name}: larger than ${FORMAT.limits.fileBytes} bytes`);
    const ext = extname(name).slice(1).toLowerCase();
    const real = sniff(bytes);
    const expected = ext === 'jpeg' ? 'jpg' : ext;
    if (ext === 'css') {
      cssText = new TextDecoder().decode(bytes);
      const lower = cssText.toLowerCase();
      const bad = FORMAT.cssForbidden.find((token) => lower.includes(token.toLowerCase()));
      if (bad) errors.push(`${name}: "${bad}" is not allowed`);
      if (/url\(\s*['"]?(?!#)/i.test(cssText)) errors.push(`${name}: url() to anything but #id is not allowed`);
    } else if (real !== expected) {
      errors.push(`${name}: content is ${real ?? 'unknown'}, not .${ext}`);
    } else if (manifest.kind === 'images' && manifest.states?.IDLE === name && isAnimated(real, bytes)) {
      warnings.push(`${name}: the IDLE image is animated — it keeps the CPU busy while the creature sleeps`);
    }
  }
  if (total > FORMAT.limits.totalBytes) errors.push(`files total more than ${FORMAT.limits.totalBytes} bytes`);

  // With the files in hand, a bound keyframes name must exist: in the avatar's own
  // stylesheet or in the widget's built-in library.
  if (manifest.animations?.states) {
    const known = new Set([...cssKeyframeNames(cssText), ...FORMAT.animations.builtinKeyframes]);
    for (const [state, spec] of Object.entries(manifest.animations.states)) {
      for (const [where, kf] of [[state, spec.keyframes], [`${state}.enter`, spec.enter?.keyframes]] as const) {
        if (typeof kf === 'string' && !known.has(kf)) {
          errors.push(`animations.states.${where}: keyframes "${kf}" is neither in the avatar's css nor a built-in (${FORMAT.animations.builtinKeyframes.join(', ')})`);
        }
      }
    }
  }
  return { manifest, files, errors, warnings };
}
