import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT } from '../src/avatar-format.ts';
// @ts-ignore — a plain browser module, typed by its JSDoc only.
import { DEFAULT_BEHAVIOR, PROFILES, MOTION_RULES, compileBehavior, mergeBehavior, behaviorFromManifest, enterStates, enterNames } from '../../../apps/widget/web/behavior.js';
// @ts-ignore — same.
import { FORBIDDEN_CSS, keyframeNames, scopeCss } from '../../../apps/widget/web/avatar.js';

const lines = (css: string): string[] =>
  css.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).sort();

/**
 * The exact rules index.html hardcoded before the behavior layer existed. Selector and
 * value identical: existing avatar CSS overrides these by specificity, and a drift here
 * would silently change which rule wins. Do not "normalize" this fixture.
 */
const CLASSIC_RULES = [
  '.body { animation: breathe var(--dur, 3.2s) ease-in-out infinite; }',
  '.critter[data-state="HIGH_LOAD"] .shaker { animation: shake .12s linear infinite; }',
  '.critter[data-state="ERROR"] .shaker { animation: shake .4s linear infinite; }',
  '.critter.mini:not(.walking)[data-state="READING"] { animation: nod calc(2.4s * var(--k, 1)) ease-in-out infinite; }',
  '.critter.mini:not(.walking)[data-state="CODING"] { animation: tap calc(.36s * var(--k, 1)) cubic-bezier(.3, 0, .3, 1) infinite; }',
  '.critter.mini:not(.walking)[data-state="TOOL_CALL"] { animation: hammer calc(.8s * var(--k, 1)) cubic-bezier(.6, 0, .2, 1) infinite; }',
  '.critter.mini:not(.walking)[data-state="THINKING"] { animation: float calc(2.6s * var(--k, 1)) ease-in-out infinite; }',
  '.critter.mini:not(.walking)[data-state="DONE"] { animation: cheer calc(1.6s * var(--k, 1)) cubic-bezier(.3, 0, .25, 1) infinite; }',
  '.critter.mini.walking.lean-l { animation: step-l calc(.3s * var(--k, 1)) ease-in-out infinite; }',
  '.critter.mini.walking.lean-r { animation: step-r calc(.3s * var(--k, 1)) ease-in-out infinite; }',
  // Added by the behavior layer, not inherited from the old stylesheet: the IDLE rest
  // pose, the DONE/ERROR enter one-shots, and the kid lifecycle.
  '.critter[data-state="IDLE"] .body { animation: none; }',
  '.critter[data-state="ERROR"].enter { animation: flinch .3s ease-out 1; }',
  '.critter[data-state="DONE"].enter { animation: hop .5s ease-out 1; }',
  '.critter.mini.spawn:not(.walking) { animation: spawn-in .35s ease-out 1; }',
  '.critter.mini.despawn:not(.walking) { animation: despawn-out .3s ease-in 1 forwards; }',
].sort();

test('compile: the default behavior is the exact CSS it replaced', () => {
  assert.deepEqual(lines(compileBehavior(DEFAULT_BEHAVIOR)), CLASSIC_RULES);
});

test('compile: classic is the default profile', () => {
  assert.equal(PROFILES.classic, DEFAULT_BEHAVIOR);
});

test('compile: never emits a pause override or !important', () => {
  const css = compileBehavior(DEFAULT_BEHAVIOR);
  assert.ok(!/animation-play-state/i.test(css));
  assert.ok(!/!important/i.test(css));
});

test('compile: an avatar scope qualifies every selector', () => {
  const css = compileBehavior(DEFAULT_BEHAVIOR, '.critter[data-avatar="ghost"]');
  const out = lines(css);
  assert.ok(out.includes('.critter[data-avatar="ghost"] .body { animation: breathe var(--dur, 3.2s) ease-in-out infinite; }'));
  assert.ok(out.includes('.critter[data-avatar="ghost"][data-state="ERROR"] .shaker { animation: shake .4s linear infinite; }'));
  assert.ok(out.includes('.critter[data-avatar="ghost"].mini.walking.lean-l { animation: step-l calc(.3s * var(--k, 1)) ease-in-out infinite; }'));
  assert.ok(!css.includes(' .critter.mini'), 'no unscoped mini selector may leak');
});

test('compile: the keyframe-name mapper reaches loops, gestures, walk and enters', () => {
  const css = compileBehavior(DEFAULT_BEHAVIOR, '', (n: string) => `av-x-${n}`);
  assert.ok(css.includes('animation: av-x-breathe '));
  assert.ok(css.includes('animation: av-x-step-l '));
  assert.ok(css.includes('animation: av-x-hop '));
  assert.ok(css.includes('animation: av-x-shake '));
  // Only `animation: none` (the rest pose) and the fixed lifecycle escape the mapper.
  const unmapped = [...css.matchAll(/animation: (?!av-x-)([\w-]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(unmapped)], ['despawn-out', 'none', 'spawn-in']);
});

test('compile: IDLE with no loop switches the every-state loop off', () => {
  const css = compileBehavior(DEFAULT_BEHAVIOR);
  assert.ok(css.includes('.critter[data-state="IDLE"] .body { animation: none; }'));
});

test('compile: an enter one-shot outranks its state loop and never loops', () => {
  const css = compileBehavior({
    states: {
      '*': { loop: { target: 'body', kf: 'bob', dur: 1000 } },
      DONE: { enter: { target: 'body', kf: 'tip', dur: 900, count: 2 } },
    },
  });
  assert.ok(css.includes('.critter[data-state="DONE"].enter .body { animation: tip .9s ease 2; }'));
  assert.ok(!css.includes('tip .9s ease infinite'));
});

test('compile: the kid lifecycle is widget-owned, never avatar-scoped', () => {
  const scoped = compileBehavior(DEFAULT_BEHAVIOR, '.critter[data-avatar="ghost"]');
  assert.ok(!scoped.includes('spawn-in'));
  assert.ok(!scoped.includes('despawn-out'));
  assert.ok(scoped.includes('.critter[data-avatar="ghost"][data-state="DONE"].enter { animation: hop .5s ease-out 1; }'));
});

test('enterStates/enterNames: the states that play an enter, and the names that end one', () => {
  assert.deepEqual([...enterStates(DEFAULT_BEHAVIOR)].sort(), ['DONE', 'ERROR']);
  assert.deepEqual([...enterNames(DEFAULT_BEHAVIOR)].sort(), ['flinch', 'hop']);
  assert.deepEqual([...enterNames(DEFAULT_BEHAVIOR, (n: string) => `av-g-${n}`)].sort(), ['av-g-flinch', 'av-g-hop']);
});

test('compile: an unknown target is dropped, not guessed', () => {
  const css = compileBehavior({
    states: {
      '*': { loop: { target: 'tentacle', kf: 'wiggle', dur: 500 } },
      ERROR: { also: { target: 'shaker', kf: 'shake', dur: 400, ease: 'linear' } },
    },
  });
  assert.ok(!css.includes('wiggle'));
  assert.ok(!css.includes('tentacle'));
  assert.ok(css.includes('shake'));
});

test('merge: an override replaces its states and keeps the rest', () => {
  const merged = mergeBehavior(DEFAULT_BEHAVIOR, {
    states: {
      '*': { loop: { target: 'body', kf: 'bob', dur: 2600 } },
      HIGH_LOAD: null, // a profile may remove a motion outright
    },
    mini: { CODING: { kf: 'wiggle', dur: 500 } },
  });
  const out = compileBehavior(merged);
  assert.ok(out.includes('animation: bob 2.6s ease infinite'));
  assert.ok(!out.includes('breathe'));
  assert.ok(!out.includes('.12s'), 'HIGH_LOAD shake removed');
  assert.ok(out.includes('shake .4s'), 'ERROR shake kept');
  assert.ok(out.includes('wiggle'));
  assert.ok(out.includes('nod'), 'untouched mini gestures kept');
  assert.ok(out.includes('step-l'), 'walk kept');
});

test('merge: no override is a no-op', () => {
  assert.equal(compileBehavior(mergeBehavior(DEFAULT_BEHAVIOR, null)), compileBehavior(DEFAULT_BEHAVIOR));
});

// ---- the manifest's `animations` section (the page's last gate) --------------------------

test('manifest: a valid section converts to typed motions', () => {
  const { override, dropped } = behaviorFromManifest({
    states: {
      THINKING: { target: 'body', keyframes: 'bob', dur: 2600, ease: 'ease-in-out', amp: 1.2 },
      CODING: { keyframes: 'wiggle', dur: 'auto' },
      IDLE: { keyframes: null },
      DONE: { enter: { keyframes: 'tip', dur: 900, ease: [0.3, 0, 0.3, 1], count: 2 } },
      ERROR: { fallback: 'DONE' },
    },
  }, new Set(['bob', 'wiggle', 'tip']));
  assert.deepEqual(dropped, []);
  assert.deepEqual(override.states.THINKING.loop, { target: 'body', kf: 'bob', dur: 2600, ease: 'ease-in-out', amp: 1.2 });
  assert.equal(override.states.CODING.loop.dur, 'auto');
  assert.equal(override.states.IDLE.loop, null);
  assert.deepEqual(override.states.DONE.enter, { target: 'root', kf: 'tip', dur: 900, ease: 'cubic-bezier(0.3, 0, 0.3, 1)', count: 2 });
  assert.deepEqual(override.states.ERROR.enter, override.states.DONE.enter, 'fallback reuses the other state');
  const css = compileBehavior(mergeBehavior(DEFAULT_BEHAVIOR, override), '.critter[data-avatar="x"]', (n: string) => `av-x-${n}`);
  assert.ok(css.includes('.critter[data-avatar="x"][data-state="THINKING"] .body { animation: av-x-bob 2.6s ease-in-out infinite; --amp-k: 1.2; }'));
});

test('manifest: hostile or unknown values are dropped or clamped, never emitted', () => {
  const { override, dropped } = behaviorFromManifest({
    states: {
      THINKING: { keyframes: 'x}body{background:url(//evil)' },
      CODING: { keyframes: 'ghost-only' },             // defined nowhere
      READING: { keyframes: 'breathe', dur: 9e9, amp: 99, ease: [9, -9, 0, 1] },
      WAITING: { target: 'tentacle', keyframes: 'breathe' },
      DONE: { enter: { keyframes: 'breathe', count: 99 } },
    },
  }, new Set());
  assert.equal(dropped.length, 3, dropped.join('; '));
  assert.equal(override.states.THINKING, undefined);
  assert.equal(override.states.CODING, undefined);
  assert.equal(override.states.WAITING, undefined);
  const r = override.states.READING.loop;
  assert.equal(r.dur, 10000, 'duration clamped');
  assert.equal(r.amp, 3, 'amplitude clamped');
  assert.equal(r.ease, 'cubic-bezier(1.5, -0.5, 0, 1)', 'bezier clamped');
  assert.equal(override.states.DONE.enter.count, 10, 'count clamped');
  const css = compileBehavior(mergeBehavior(DEFAULT_BEHAVIOR, override));
  assert.ok(!css.includes('evil') && !css.includes('}body{'));
});

test('manifest: no section means no override', () => {
  assert.deepEqual(behaviorFromManifest(undefined).override, { states: {} });
  assert.deepEqual(behaviorFromManifest({ profile: 'classic' }).override, { states: {} });
});

// ---- conformance: the page's copies of the shared rules never drift ----------------------

test('conformance: MOTION_RULES matches avatar-format.json', () => {
  const A = FORMAT.animations;
  assert.deepEqual(MOTION_RULES.profiles, A.profiles);
  assert.deepEqual(MOTION_RULES.targets, A.targets);
  assert.deepEqual(MOTION_RULES.builtinKeyframes, A.builtinKeyframes);
  assert.deepEqual(MOTION_RULES.easings, A.easings);
  assert.deepEqual(MOTION_RULES.bezierRange, A.bezierRange);
  assert.deepEqual(MOTION_RULES.durMs, A.durMs);
  assert.deepEqual(MOTION_RULES.ampRange, A.ampRange);
  assert.equal(MOTION_RULES.maxCount, A.maxCount);
  assert.equal(MOTION_RULES.keyframePattern.source, A.keyframePattern);
  assert.ok(Object.keys(PROFILES).every((p) => A.profiles.includes(p)), 'every page profile is declared in the format');
});

test('conformance: every cssForbidden token is refused by the page sanitizer', () => {
  for (const token of FORMAT.cssForbidden) {
    assert.ok(FORBIDDEN_CSS.test(token), `FORBIDDEN_CSS misses ${JSON.stringify(token)}`);
    assert.throws(() => scopeCss(`.critter { x: ${token} }`, 'x'), `scopeCss accepts ${JSON.stringify(token)}`);
  }
});

test('conformance: keyframeNames sees through comments and matches the scoper', () => {
  const css = '/* @keyframes fake */ @keyframes bob { to { opacity: 1 } }\n@keyframes drift-2 { to { opacity: 0 } }';
  assert.deepEqual([...keyframeNames(css)].sort(), ['bob', 'drift-2']);
});
