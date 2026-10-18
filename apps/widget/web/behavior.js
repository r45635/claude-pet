/**
 * The animation behavior layer: WHAT plays per state, on WHICH part, how fast.
 *
 * Pure data compiled to a stylesheet — nothing here runs per frame. The page compiles
 * the default map once at startup, and again on avatar switch with the avatar's
 * overrides merged in. Appearance stays in avatar.js; activity stays in the engine.
 *
 * The compiler builds CSS from typed tokens only (enum targets, numeric durations,
 * known keyframe names) and never emits `animation-play-state` or `!important`, so the
 * global idle/pause rules in index.html keep stopping every animation it produces
 * (docs/RISKS.md #6, docs/MOTION.md).
 *
 * Plain browser module, also imported by node tests.
 */

/**
 * A motion: one `animation:` declaration.
 *   target 'root' is the .critter element itself; 'shaker' | 'body' | 'eyes' are the
 *   wrapper groups every avatar skeleton provides. `dur` is in milliseconds, or 'auto'
 *   for the widget's load-driven speed (var(--dur)).
 * @typedef {{ target?: 'root'|'shaker'|'body'|'eyes', kf: string, dur: number|'auto', ease?: string }} Motion
 */

/**
 * The classic creature's behavior, extracted verbatim from what index.html hardcoded:
 * compiled output must stay selector-identical so existing avatar CSS keeps overriding
 * it by the same specificity (see behavior.test.ts).
 *
 * `states['*'].loop` runs in every state; a state may add a second motion (`also`).
 * `mini` is the stopped subagent's gesture per state (tempo follows the family's --k);
 * `walk` is the step bounce while a subagent moves.
 */
export const DEFAULT_BEHAVIOR = {
  states: {
    '*': { loop: { target: 'body', kf: 'breathe', dur: 'auto', ease: 'ease-in-out' } },
    // Asleep = at rest, not frozen mid-breath: no loop at all snaps the body back to
    // its drawn pose (the pause rules in index.html still freeze everything else).
    IDLE: { loop: null },
    HIGH_LOAD: { also: { target: 'shaker', kf: 'shake', dur: 120, ease: 'linear' } },
    ERROR: {
      also: { target: 'shaker', kf: 'shake', dur: 400, ease: 'linear' },
      enter: { target: 'root', kf: 'flinch', dur: 300, ease: 'ease-out' },
    },
    DONE: { enter: { target: 'root', kf: 'hop', dur: 500, ease: 'ease-out' } },
  },
  mini: {
    READING: { kf: 'nod', dur: 2400, ease: 'ease-in-out' },
    CODING: { kf: 'tap', dur: 360, ease: 'cubic-bezier(.3, 0, .3, 1)' },
    TOOL_CALL: { kf: 'hammer', dur: 800, ease: 'cubic-bezier(.6, 0, .2, 1)' },
    THINKING: { kf: 'float', dur: 2600, ease: 'ease-in-out' },
    DONE: { kf: 'cheer', dur: 1600, ease: 'cubic-bezier(.3, 0, .25, 1)' },
  },
  walk: {
    left: { kf: 'step-l', dur: 300, ease: 'ease-in-out' },
    right: { kf: 'step-r', dur: 300, ease: 'ease-in-out' },
  },
};

/** Motion profiles: the same map shaped for a different character feel. */
export const PROFILES = {
  classic: DEFAULT_BEHAVIOR,
};

const TARGETS = { root: '', shaker: ' .shaker', body: ' .body', eyes: ' .eyes' };

/**
 * The vocabulary a manifest's `animations` section may use. The same values live in
 * avatar-format.json for the creator tooling and the Rust importer; a conformance test
 * (behavior.test.ts) keeps this copy honest — the page cannot import JSON on its own.
 */
export const MOTION_RULES = {
  profiles: ['classic'],
  targets: ['root', 'shaker', 'body', 'eyes'],
  keyframePattern: /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/,
  builtinKeyframes: ['breathe', 'shake', 'nod', 'tap', 'hammer', 'float', 'cheer', 'hop', 'flinch', 'step-l', 'step-r'],
  easings: ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'],
  bezierRange: [-0.5, 1.5],
  durMs: [80, 10000],
  ampRange: [0, 3],
  maxCount: 10,
};

/** 120 → '.12s', 2400 → '2.4s' — the shorthand the stylesheet always used. */
function sec(ms) {
  return `${String(ms / 1000).replace(/^0\./, '.')}s`;
}

/** The duration expression: load tiers for 'auto', family tempo (--k) for minis. */
function durText(dur, tempo) {
  if (dur === 'auto') return 'var(--dur, 3.2s)';
  return tempo ? `calc(${sec(dur)} * var(--k, 1))` : sec(dur);
}

/**
 * Selector for a motion on the full-size creature. With no scope and no state this is
 * the bare target (`.body`), exactly as the stylesheet had it; a state or an avatar
 * scope qualifies the .critter.
 */
function critterSel(state, target, scope) {
  const base = scope || '.critter';
  const qualified = state === '*' ? (scope || '') : `${base}[data-state="${state}"]`;
  if (!qualified) return TARGETS[target].trim() || '.critter';
  return `${qualified}${TARGETS[target]}`;
}

/**
 * Merge an override map into a base map, state by state: an override's entry replaces
 * the base's entry for that state; everything it leaves out stays.
 */
export function mergeBehavior(base, override) {
  if (!override) return base;
  return {
    states: { ...base.states, ...(override.states ?? {}) },
    mini: { ...base.mini, ...(override.mini ?? {}) },
    walk: { ...base.walk, ...(override.walk ?? {}) },
  };
}

/**
 * Compile a behavior map to CSS.
 *
 * @param {object} behavior - a map shaped like DEFAULT_BEHAVIOR
 * @param {string} [scope] - '' for the built-in default; `.critter[data-avatar="<id>"]`
 *   to make the rules one avatar's own
 * @param {(name: string) => string} [kfName] - keyframe-name mapper (an avatar's own
 *   names become their private `av-<id>-…` form; built-ins pass through)
 * @returns {string} stylesheet text
 */
export function compileBehavior(behavior, scope = '', kfName = (n) => n) {
  const out = [];
  // `amp` rides the same rule as a bounded multiplier: the built-in keyframes read
  // calc(var(--amp) * var(--amp-k, 1)), so an avatar scales motion without seeing load.
  const motion = (m, tempo, count = 'infinite') =>
    `animation: ${kfName(m.kf)} ${durText(m.dur, tempo)} ${m.ease ?? 'ease'} ${count};` +
    (typeof m.amp === 'number' ? ` --amp-k: ${m.amp};` : '');

  const starTarget = behavior.states?.['*']?.loop?.target ?? null;
  for (const [state, entry] of Object.entries(behavior.states ?? {})) {
    if (!entry) continue;
    // `loop: null` on a state switches the every-state loop off there: the element
    // returns to its drawn rest pose instead of freezing mid-cycle.
    if (state !== '*' && 'loop' in entry && entry.loop === null && starTarget) {
      out.push(`${critterSel(state, starTarget, scope)} { animation: none; }`);
    }
    for (const m of [entry.loop, entry.also]) {
      if (!m || !((m.target ?? 'root') in TARGETS)) continue; // unknown target: drop, never guess
      out.push(`${critterSel(state, m.target ?? 'root', scope)} { ${motion(m, false)} }`);
    }
    // The enter one-shot plays while the short-lived .enter class is on (index.html
    // removes it on animationend). Its selector outranks the same state's loop, so
    // "anticipation, then the loop" is sequenced by CSS alone.
    const e = entry.enter;
    if (e && state !== '*' && (e.target ?? 'root') in TARGETS) {
      const base = `${scope || '.critter'}[data-state="${state}"].enter`;
      out.push(`${base}${TARGETS[e.target ?? 'root']} { ${motion(e, false, String(e.count ?? 1))} }`);
    }
  }

  const mini = scope ? `${scope}.mini` : '.critter.mini';
  for (const [state, m] of Object.entries(behavior.mini ?? {})) {
    if (!m) continue;
    out.push(`${mini}:not(.walking)[data-state="${state}"] { ${motion(m, true)} }`);
  }

  const walk = behavior.walk ?? {};
  for (const [side, m] of [['lean-l', walk.left], ['lean-r', walk.right]]) {
    if (!m) continue;
    out.push(`${mini}.walking.${side} { ${motion(m, true)} }`);
  }

  // Kid lifecycle (fixed, not an avatar surface): last in the sheet so it outranks the
  // gesture rules above at equal specificity while the .spawn/.despawn class is on.
  if (!scope) {
    out.push(`${mini}.spawn:not(.walking) { animation: spawn-in .35s ease-out 1; }`);
    out.push(`${mini}.despawn:not(.walking) { animation: despawn-out .3s ease-in 1 forwards; }`);
  }

  return `${out.join('\n')}\n`;
}

/**
 * Turn a manifest's optional `animations` section into a behavior override map.
 *
 * This is the page's last gate on untrusted input: everything it keeps is a typed
 * token — enum target, known keyframe name, clamped numbers — and everything else is
 * dropped with a reason. The TS tooling and the Rust importer validated the same rules
 * earlier, so a drop here means a hand-edited install, not a normal import.
 *
 * @param {object|undefined} anims - the manifest section
 * @param {Set<string>} [ownKf] - keyframe names the avatar's own CSS defines
 * @returns {{ override: object, dropped: string[] }}
 */
export function behaviorFromManifest(anims, ownKf = new Set()) {
  const R = MOTION_RULES;
  const dropped = [];
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  const motionSpec = (spec, where, enter) => {
    if (!spec || typeof spec !== 'object') return null;
    const kf = spec.keyframes;
    if (typeof kf !== 'string' || !R.keyframePattern.test(kf)
        || !(ownKf.has(kf) || R.builtinKeyframes.includes(kf))) {
      dropped.push(`${where}: unknown keyframes ${JSON.stringify(kf ?? null)}`);
      return null;
    }
    const target = spec.target ?? (enter ? 'root' : 'body');
    if (!R.targets.includes(target)) {
      dropped.push(`${where}: unknown target ${JSON.stringify(spec.target)}`);
      return null;
    }
    let ease = 'ease';
    if (R.easings.includes(spec.ease)) ease = spec.ease;
    else if (Array.isArray(spec.ease) && spec.ease.length === 4 && spec.ease.every((n) => Number.isFinite(n))) {
      ease = `cubic-bezier(${spec.ease.map((n) => clamp(n, R.bezierRange)).join(', ')})`;
    } else if (spec.ease !== undefined) {
      dropped.push(`${where}: unknown easing`);
      return null;
    }
    const m = { target, kf, ease, dur: spec.dur === 'auto' || spec.dur === undefined ? 'auto' : clamp(Math.trunc(spec.dur) || R.durMs[0], R.durMs) };
    if (typeof spec.amp === 'number' && Number.isFinite(spec.amp)) m.amp = clamp(spec.amp, R.ampRange);
    if (enter) m.count = clamp(Math.trunc(spec.count ?? 1) || 1, [1, R.maxCount]);
    return m;
  };

  const src = (anims && typeof anims === 'object' && anims.states && typeof anims.states === 'object') ? anims.states : {};
  const states = {};
  for (const [state, raw] of Object.entries(src)) {
    // A fallback entry reuses another state's spec; chains are bounded like the
    // picture fallbacks are.
    let spec = raw;
    let hops = 0;
    while (spec && typeof spec === 'object' && typeof spec.fallback === 'string' && hops < 8) {
      spec = src[spec.fallback];
      hops += 1;
    }
    if (!spec || typeof spec !== 'object') {
      dropped.push(`${state}: empty after fallback`);
      continue;
    }
    const entry = {};
    if (spec.keyframes === null) entry.loop = null;
    else if (spec.keyframes !== undefined) {
      const m = motionSpec(spec, state, false);
      if (m) entry.loop = m;
    }
    if (spec.enter !== undefined) {
      const m = motionSpec(spec.enter, `${state}.enter`, true);
      if (m) entry.enter = m;
    }
    if (Object.keys(entry).length > 0) states[state] = entry;
  }
  return { override: { states }, dropped };
}

/** The states whose arrival plays an enter one-shot. */
export function enterStates(behavior) {
  return new Set(
    Object.entries(behavior.states ?? {})
      .filter(([state, entry]) => state !== '*' && entry?.enter)
      .map(([state]) => state),
  );
}

/**
 * The animation names whose end means "take the .enter class off" — the delegated
 * animationend listener in index.html ignores every other animation.
 */
export function enterNames(behavior, kfName = (n) => n) {
  return new Set(
    Object.values(behavior.states ?? {})
      .map((entry) => entry?.enter?.kf)
      .filter(Boolean)
      .map((kf) => kfName(kf)),
  );
}
