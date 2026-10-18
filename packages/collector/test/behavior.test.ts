import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — a plain browser module, typed by its JSDoc only.
import { DEFAULT_BEHAVIOR, PROFILES, compileBehavior, mergeBehavior, enterStates, enterNames } from '../../../apps/widget/web/behavior.js';

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
