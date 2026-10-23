/**
 * Where the families stand when several Claude Code sessions are on screen: pure geometry,
 * no DOM, imported by the page and by node tests (like behavior.js).
 *
 * Two layouts share the same units — the page's 160-wide viewBox, `H` high (less when the
 * usage gauge takes the bottom strip) — and the same family templates (`G`: a cell `w`×`h`,
 * the parent's box inside it, `step` between neighbours):
 *
 *   - the grid: every column count is tried, the one where families come out biggest wins;
 *   - gravity: families are pulled toward the centre and push each other away, and depth
 *     planes (front, middle, back) say who matters now — the session waiting for you and the
 *     busiest one in front, sleeping ones at the back, smaller and behind.
 *
 * Both are computed once per change (a session arriving, leaving, changing plane) and reached
 * by a CSS transition: nothing here runs per frame.
 */

/** Spacing preference → multiplier on the distance between families. */
export const SPACING = { tight: 0.75, normal: 1, roomy: 1.2 };
/** Depth plane → scale of the family. */
export const PLANE_SCALE = { front: 1, middle: 0.85, back: 0.7 };
export const PLANES = ['back', 'middle', 'front'];
/**
 * Seconds per turn around the centre, per plane: the heart (front) stays still — what needs
 * you is always where you look — and the farther a plane, the slower it turns, so the planes
 * slide past each other like a galaxy's arms.
 */
export const ORBIT_PERIOD = { front: 0, middle: 90, back: 150 };

export const span = (n, size, step) => size + step * (n - 1);

/** The grid: column count where families are biggest, and each family's cell origin. */
export function gridLayout(n, G, H, spacing = 1) {
  const step = { x: G.step.x * spacing, y: G.step.y * spacing };
  let best = { f: 0, cols: 1, rows: 1 };
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const f = Math.min(160 / span(cols, G.w, step.x), H / span(rows, G.h, step.y));
    if (f > best.f) best = { f, cols, rows };
  }
  const { f, cols, rows } = best;
  const x0 = (160 - f * span(cols, G.w, step.x)) / 2;
  const y0 = (H - f * span(rows, G.h, step.y)) / 2;
  const cells = Array.from({ length: n }, (_, i) =>
    ({ x: x0 + (i % cols) * step.x * f, y: y0 + Math.floor(i / cols) * step.y * f }));
  return { f, cols, rows, cells };
}

const ACTIVE = new Set(['THINKING', 'READING', 'CODING', 'TOOL_CALL', 'HIGH_LOAD']);

/**
 * The plane a session asks for: waiting on you or in trouble → front; the busiest working
 * one → front too (when nobody waits); working → middle; asleep or done → back.
 */
export function wantedPlane(g, busiestId, someoneWaits) {
  if (g.state === 'WAITING' || g.state === 'ERROR' || g.status === 'waiting') return 'front';
  if (ACTIVE.has(g.state)) return !someoneWaits && g.id === busiestId ? 'front' : 'middle';
  return 'back';
}

/**
 * Planes with hysteresis: a family moves to a new plane only once it has wanted it for
 * `holdMs` — changing plane changes its size, which must never look like flicker. A new
 * family takes its plane at once. Returns a new map; `prev` is not modified.
 */
export function planes(groups, prev, nowMs, holdMs = 3_000) {
  const active = groups.filter((g) => ACTIVE.has(g.state));
  const busiest = active.reduce((a, b) => (b.load > (a?.load ?? -1) ? b : a), null)?.id ?? null;
  const waits = groups.some((g) => g.state === 'WAITING' || g.status === 'waiting');
  const out = new Map();
  for (const g of groups) {
    const want = wantedPlane(g, busiest, waits);
    const p = prev.get(g.id);
    if (!p) { out.set(g.id, { plane: want, want, since: nowMs }); continue; }
    if (want !== p.want) { out.set(g.id, { plane: p.plane, want, since: nowMs }); continue; }
    out.set(g.id, { plane: nowMs - p.since >= holdMs ? want : p.plane, want, since: p.since });
  }
  return out;
}

/** A stable pseudo-random angle per id, so the same sessions always settle the same way. */
function angleOf(id) {
  let h = 2166136261;
  for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 3600) / 3600 * 2 * Math.PI;
}

/**
 * Gravity: families pulled to the centre (front ones hardest), pushed apart by neighbours of
 * the same plane, kept apart more gently across planes (the back may pass behind). Returns,
 * per family, its cell origin and scale for the template `G`, plus its centre and radius.
 */
export function gravityLayout(fams, G, H, spacing = 1, { orbit = false } = {}) {
  const n = fams.length;
  const base = gridLayout(n, G, H, spacing).f * (n > 1 ? 1.08 : 1);
  const cx = 80;
  const cy = H / 2;
  const pull = { front: 0.05, middle: 0.025, back: 0.012 };
  const nodes = fams.map((fam, i) => {
    const f = base * PLANE_SCALE[fam.plane];
    const r = (G.step.x * f * spacing) / 2;
    const a = angleOf(fam.id);
    const d = fam.plane === 'front' ? 4 : 20 + 6 * i;
    return { id: fam.id, plane: fam.plane, f, r, hw: (G.w * f) / 2, hh: (G.h * f) / 2,
             x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d };
  });
  for (let it = 0; it < 400; it++) {
    for (const a of nodes) {
      a.x += (cx - a.x) * pull[a.plane];
      a.y += (cy - a.y) * pull[a.plane];
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const same = a.plane === b.plane;
        const want = (a.r + b.r) * (same ? 1.05 : 0.8);
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-6) { dx = Math.cos(angleOf(a.id + b.id)); dy = Math.sin(angleOf(a.id + b.id)); d = 1; }
        if (d >= want) continue;
        // The overlap is shared: a front family yields less than the one behind it.
        const push = (want - d) / d;
        const wa = PLANE_SCALE[b.plane] / (PLANE_SCALE[a.plane] + PLANE_SCALE[b.plane]);
        a.x -= dx * push * wa;
        a.y -= dy * push * wa;
        b.x += dx * push * (1 - wa);
        b.y += dy * push * (1 - wa);
      }
    }
    for (const a of nodes) {
      a.x = Math.min(160 - a.hw, Math.max(a.hw, a.x));
      a.y = Math.min(H - a.hh, Math.max(a.hh, a.y));
      // Orbiting: every angle of the turn must stay inside the box, so the distance to the
      // centre is held under what the family's own size leaves.
      if (orbit && ORBIT_PERIOD[a.plane] > 0) {
        const max = Math.max(0, Math.min(80 - a.hw, H / 2 - a.hh));
        const d = Math.hypot(a.x - cx, a.y - cy);
        if (d > max) {
          a.x = cx + ((a.x - cx) * max) / d;
          a.y = cy + ((a.y - cy) * max) / d;
        }
      }
    }
  }
  return nodes.map((a) => ({ id: a.id, plane: a.plane, f: a.f, cx: a.x, cy: a.y, r: a.r,
                             x: a.x - a.hw, y: a.y - a.hh }));
}

/**
 * Should two wandering parents bump? Same plane only, close enough, and neither bumped in
 * the last `gapMs` — a rare event, not a habit.
 */
export function bumpCheck(a, b, nowMs, lastBump, gapMs = 20_000, reach = 0.75) {
  if (!a || !b || a.id === b.id || a.plane !== b.plane) return false;
  if (nowMs - (lastBump.get(a.id) ?? -Infinity) < gapMs || nowMs - (lastBump.get(b.id) ?? -Infinity) < gapMs) return false;
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) < (a.r + b.r) * reach;
}
