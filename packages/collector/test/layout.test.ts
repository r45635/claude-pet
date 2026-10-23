import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — a plain browser module, like behavior.js.
import { ORBIT_PERIOD, ORBIT_TILT, SPACING, bumpCheck, gravityLayout, gridLayout, onScreen, planes, wantedPlane } from '../../../apps/widget/web/layout.js';

type Placed = { id: string; plane: string; f: number; cx: number; cy: number; sx: number; sy: number; r: number; x: number; y: number;
                hw: number; hh: number; m: number; turns: boolean; oy: number };

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
        assert.ok(a.sx - a.hw >= -1e-6 && a.sy - a.hh >= -1e-6, `${a.id} origin inside`);
        assert.ok(a.sx + a.hw <= 160 + 1e-6 && a.sy + a.hh <= H + 1e-6, `${a.id} end inside`);
      }
      const oy = out[0]!.oy;
      const dist = (a: Placed) => Math.hypot(a.sx - 80, a.sy - oy);
      const front = out.find((a) => a.plane === 'front')!;
      assert.ok(out.every((a) => dist(front) <= dist(a) + 1e-6), 'front is the most central');
      for (const a of out) for (const b of out) {
        if (a.id < b.id && a.plane === b.plane) {
          assert.ok(Math.hypot(a.sx - b.sx, a.sy - b.sy) >= (a.r + b.r) * 0.6, `${a.id}/${b.id} apart`);
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

test('orbit: inside the box at every angle, with room to stroll; the cluster rests on the floor', () => {
  assert.equal(ORBIT_PERIOD.front, 0, 'what needs you does not move');
  assert.ok(ORBIT_PERIOD.back > ORBIT_PERIOD.middle, 'the farther, the slower');
  assert.ok(ORBIT_TILT > 0 && ORBIT_TILT < 1, 'a tilted galaxy');
  for (const G of [CELL, COMPACT]) {
    for (const H of [160, 146]) {
      for (const set of [fams, fams.slice(0, 2), [{ id: 'a', plane: 'front' }, { id: 'b', plane: 'back' }]]) {
        const out: Placed[] = gravityLayout(set, G, H, 1, { orbit: true });
        let lowest = -Infinity;
        for (const a of out) {
          for (let k = 0; k < 72; k++) {
            const p = onScreen(a, (k / 72) * 2 * Math.PI);
            const e = a.hw + a.m;
            const v = a.hh + a.m;
            assert.ok(p.x - e >= -1e-6 && p.x + e <= 160 + 1e-6, `${a.id} out sideways at ${k * 5}°`);
            assert.ok(p.y - v >= -1e-6 && p.y + v <= H + 1e-6, `${a.id} out vertically at ${k * 5}°`);
            lowest = Math.max(lowest, p.y + v);
            if (!a.turns) break;
          }
        }
        assert.ok(Math.abs(lowest - H) < 0.5, `rests on the floor (lowest ${lowest.toFixed(2)} vs ${H})`);
        const p0 = onScreen(out[0]!, 0);
        assert.ok(Math.abs(p0.x - out[0]!.sx) < 1e-6 && Math.abs(p0.y - out[0]!.sy) < 1e-6, 'θ = 0 is where it was laid out');
      }
    }
  }
});

test('grid: bottom alignment rests the rows on the floor', () => {
  const g = gridLayout(2, COMPACT, 146, 1, { align: 'bottom' });
  const bottom = Math.max(...g.cells.map((c: { y: number }) => c.y)) + COMPACT.h * g.f;
  assert.ok(Math.abs(bottom - 146) < 1e-6);
});
