import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — a plain browser module, like behavior.js.
import { ORBIT_PERIOD, SPACING, bumpCheck, gravityLayout, gridLayout, planes, wantedPlane } from '../../../apps/widget/web/layout.js';

type Placed = { id: string; plane: string; f: number; cx: number; cy: number; r: number; x: number; y: number };

// The page's templates (index.html): cells with a walking area, and close-packed ones.
const CELL = { w: 180, h: 96, parent: { x: 55, y: 6, size: 70 }, step: { x: 144, y: 74 } };
const COMPACT = { w: 80, h: 76, parent: { x: 5, y: 3, size: 70 }, step: { x: 66, y: 60 } };

test('grid: unchanged at normal spacing, bigger families when tight', () => {
  const normal = gridLayout(4, COMPACT, 160, SPACING.normal);
  assert.deepEqual([normal.cols, normal.rows], [2, 2]);
  assert.ok(Math.abs(normal.f - 160 / (80 + 66)) < 1e-9, 'the same scale as before the setting existed');
  const tight = gridLayout(4, COMPACT, 160, SPACING.tight);
  const roomy = gridLayout(4, COMPACT, 160, SPACING.roomy);
  assert.ok(tight.f > normal.f * 1.1 && roomy.f < normal.f, `tight ${tight.f} normal ${normal.f} roomy ${roomy.f}`);
  for (const c of tight.cells) assert.ok(c.x >= -1e-9 && c.y >= -1e-9);
});

test('planes: who waits is in front, the busiest next, sleepers at the back', () => {
  const groups = [
    { id: 'a', state: 'CODING', load: 80 }, { id: 'b', state: 'READING', load: 30 },
    { id: 'c', state: 'IDLE', load: 0 }, { id: 'd', state: 'DONE', load: 0 },
  ];
  const p = planes(groups, new Map(), 0);
  assert.deepEqual([...p].map(([id, v]) => [id, v.plane]), [['a', 'front'], ['b', 'middle'], ['c', 'back'], ['d', 'back']]);
  const waiting = planes([...groups, { id: 'e', state: 'WAITING', load: 10 }], new Map(), 0);
  assert.equal(waiting.get('e').plane, 'front');
  assert.equal(waiting.get('a').plane, 'middle', 'someone waits: the busiest steps back');
  assert.equal(wantedPlane({ id: 'x', state: 'ERROR' }, null, false), 'front');
});

test('planes: a family changes plane only after holding the new state', () => {
  let p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'IDLE', load: 0 }], new Map(), 0);
  assert.equal(p.get('b').plane, 'back');
  p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'WAITING', load: 0 }], p, 1_000);
  assert.equal(p.get('b').plane, 'back', 'not yet');
  p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'WAITING', load: 0 }], p, 3_500);
  assert.equal(p.get('b').plane, 'back', '2.5 s since it changed: still not');
  p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'WAITING', load: 0 }], p, 4_100);
  assert.equal(p.get('b').plane, 'front', 'held for 3 s: it moves');
  p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'IDLE', load: 0 }], p, 4_500);
  p = planes([{ id: 'a', state: 'CODING', load: 50 }, { id: 'b', state: 'WAITING', load: 0 }], p, 5_000);
  assert.equal(p.get('b').plane, 'front', 'a blip back and forth changes nothing');
});

const fams = [
  { id: 's1', plane: 'middle' }, { id: 's2', plane: 'front' }, { id: 's3', plane: 'back' },
  { id: 's4', plane: 'middle' }, { id: 's5', plane: 'back' },
];

test('gravity: inside the box, the front family closest to the centre, same plane apart', () => {
  for (const G of [CELL, COMPACT]) {
    for (const H of [160, 146]) {
      const out: Placed[] = gravityLayout(fams, G, H, 1);
      for (const a of out) {
        assert.ok(a.x >= -1e-6 && a.y >= -1e-6, `${a.id} origin inside`);
        assert.ok(a.x + G.w * a.f <= 160 + 1e-6 && a.y + G.h * a.f <= H + 1e-6, `${a.id} end inside`);
      }
      const dist = (a: Placed) => Math.hypot(a.cx - 80, a.cy - H / 2);
      const front = out.find((a) => a.plane === 'front')!;
      assert.ok(out.every((a) => dist(front) <= dist(a) + 1e-6), 'front is the most central');
      for (const a of out) for (const b of out) {
        if (a.id < b.id && a.plane === b.plane) {
          assert.ok(Math.hypot(a.cx - b.cx, a.cy - b.cy) >= (a.r + b.r) * 0.6, `${a.id}/${b.id} apart`);
        }
      }
      const scale = Object.fromEntries(out.map((a) => [a.id, a.f]));
      assert.ok(scale.s2 > scale.s1 && scale.s1 > scale.s3, 'nearer planes are bigger');
    }
  }
});

test('gravity: deterministic — the same sessions settle the same way', () => {
  assert.deepEqual(gravityLayout(fams, CELL, 160, 1), gravityLayout(fams, CELL, 160, 1));
  assert.deepEqual(gravityLayout([{ id: 'only', plane: 'front' }], COMPACT, 160, 1).length, 1);
});

test('bump: same plane, close, and not twice within the gap', () => {
  const a = { id: 'a', plane: 'middle', cx: 50, cy: 50, r: 20 };
  const b = { id: 'b', plane: 'middle', cx: 70, cy: 50, r: 20 };
  const last = new Map();
  assert.equal(bumpCheck(a, b, 0, last), true);
  assert.equal(bumpCheck(a, { ...b, plane: 'back' }, 0, last), false, 'different planes pass by');
  assert.equal(bumpCheck(a, { ...b, cx: 120 }, 0, last), false, 'far apart');
  last.set('a', 0);
  assert.equal(bumpCheck(a, b, 10_000, last), false, 'a bumped 10 s ago');
  assert.equal(bumpCheck(a, b, 25_000, last), true);
});

test('orbit: every family stays inside the box at every angle of its turn; the heart stays still', () => {
  assert.equal(ORBIT_PERIOD.front, 0, 'what needs you does not move');
  assert.ok(ORBIT_PERIOD.back > ORBIT_PERIOD.middle, 'the farther, the slower');
  for (const G of [CELL, COMPACT]) {
    for (const H of [160, 146]) {
      const out: Placed[] = gravityLayout(fams, G, H, 1, { orbit: true });
      for (const a of out) {
        if (a.plane === 'front') continue;
        const d = Math.hypot(a.cx - 80, a.cy - H / 2);
        const hw = (G.w * a.f) / 2;
        const hh = (G.h * a.f) / 2;
        assert.ok(d + hw <= 80 + 1e-6 && d + hh <= H / 2 + 1e-6, `${a.id} leaves the box while turning (d ${d.toFixed(1)})`);
      }
    }
  }
});
