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
    HIGH_LOAD: { also: { target: 'shaker', kf: 'shake', dur: 120, ease: 'linear' } },
    ERROR: { also: { target: 'shaker', kf: 'shake', dur: 400, ease: 'linear' } },
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
  const motion = (m, tempo) =>
    `animation: ${kfName(m.kf)} ${durText(m.dur, tempo)} ${m.ease ?? 'ease'} infinite;`;

  for (const [state, entry] of Object.entries(behavior.states ?? {})) {
    if (!entry) continue;
    for (const m of [entry.loop, entry.also]) {
      if (!m || !((m.target ?? 'root') in TARGETS)) continue; // unknown target: drop, never guess
      out.push(`${critterSel(state, m.target ?? 'root', scope)} { ${motion(m, false)} }`);
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

  return `${out.join('\n')}\n`;
}
