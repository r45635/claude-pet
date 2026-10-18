/**
 * Avatars: what the creature looks like (docs/AVATARS.md).
 *
 * An avatar is UNTRUSTED content, and this page holds the chat's IPC — a full agent. So
 * nothing from an avatar reaches the DOM except through an allow-list: SVG elements and
 * attributes by name, links only to `#id` or a data: image, CSS scoped to the creature
 * with no external url(), no @import, no @font-face, no escapes. The widget's CSP is the
 * second line of defence, not the first.
 *
 * Pure functions over a Document, so the browser harness can test them (avatar-test.html).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

export const DEFAULT_GEO = { feet: [80, 146], why: [66, 26] };
export const DEFAULT_HITBOX = { cx: 80, cy: 92, rx: 48, ry: 52 };

// ---- kind "images" ---------------------------------------------------------------------

/**
 * States → image, after the format's fallbacks (THINKING → ACTIVE → IDLE …). The widget's
 * importer resolves this itself; the harness uses it to mimic the importer.
 */
export function resolveStates(states, fallback, allStates) {
  const out = {};
  for (const state of allStates) {
    let key = state;
    const seen = new Set();
    while (!states[key] && fallback[key] && !seen.has(key)) {
      seen.add(key);
      key = fallback[key];
    }
    out[state] = states[key] ?? states.IDLE;
  }
  return out;
}

/**
 * A prototype for an image avatar: the same wrapper groups as the classic creature, so
 * breathing (.body), shaking (.shaker) and the subagents' walk apply unchanged; one
 * <image> per distinct picture, carrying the class of every state that shows it; and an
 * invisible ellipse as `.shell`, for clicks.
 * `avatar.images`: { STATE: "data:image/…" } for all nine states.
 */
export function buildImageProto(doc, avatar) {
  const el = (name, attrs = {}) => {
    const node = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };
  const critter = el('g', { class: 'critter', 'data-state': 'IDLE', 'data-kind': 'images', 'data-avatar': avatar.id });
  const shaker = el('g', { class: 'shaker' });
  const body = el('g', { class: 'body' });
  const hb = { ...DEFAULT_HITBOX, ...(avatar.hitbox ?? {}) };
  body.appendChild(el('ellipse', { class: 'shell', cx: hb.cx, cy: hb.cy, rx: hb.rx, ry: hb.ry }));

  const byUrl = new Map();
  for (const [state, url] of Object.entries(avatar.images)) {
    if (!isSafeImageUrl(url)) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(state);
  }
  const idleUrl = avatar.images.IDLE;
  for (const [url, states] of byUrl) {
    const classes = ['opt', ...states.map((s) => `on-${s}`)];
    if (url === idleUrl) classes.push('on-NOSIGNAL'); // greyed by CSS when unplugged
    body.appendChild(el('image', {
      class: classes.join(' '), href: url, x: 0, y: 0, width: 160, height: 160,
      preserveAspectRatio: 'xMidYMax meet',
    }));
  }
  shaker.appendChild(body);
  critter.appendChild(shaker);
  return critter;
}

// ---- kind "svg" ------------------------------------------------------------------------

const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline',
  'polygon', 'text', 'tspan', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'mask', 'title', 'desc', 'use', 'image', 'symbol']);
const ATTRIBUTES = new Set(['id', 'class', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1',
  'x2', 'y2', 'width', 'height', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity', 'visibility', 'display',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'textlength', 'lengthadjust', 'viewbox', 'preserveaspectratio', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy',
  'clip-path', 'clippathunits', 'mask', 'maskunits', 'maskcontentunits', 'paint-order',
  'vector-effect', 'data-state', 'href', 'xmlns', 'xmlns:xlink']);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=\s]+$/;

export function isSafeImageUrl(url) {
  return typeof url === 'string' && DATA_IMAGE.test(url);
}

/** A value may only point inside the avatar: url(#id), never anywhere else. */
function safeValue(value) {
  if (/javascript:|expression\s*\(|@import|\\/i.test(value)) return false;
  for (const m of value.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!m[2].startsWith('#')) return false;
  }
  return !/url\(/i.test(value.replace(/url\(\s*(['"]?)#[^'")]*\1\s*\)/gi, ''));
}

/**
 * Strip everything not on the allow-list, in place. Returns the number of things removed,
 * for diagnostics. Whole subtrees go with a forbidden element (script, foreignObject,
 * style, a, animate/set — SMIL can rewrite an href at runtime —, iframe, …).
 */
export function sanitizeSvg(root) {
  let removed = 0;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) { child.remove(); continue; } // comments
      if (child.nodeType === 3) continue;                      // text
      if (child.nodeType !== 1 || child.namespaceURI !== SVG_NS ||
          !ELEMENTS.has(child.localName.toLowerCase())) {
        child.remove();
        removed += 1;
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const isXlinkHref = attr.namespaceURI === XLINK_NS && attr.localName === 'href';
        let ok = (ATTRIBUTES.has(name) || isXlinkHref) && !name.startsWith('on') && safeValue(attr.value);
        if (ok && (name === 'href' || isXlinkHref)) {
          const v = attr.value.trim();
          ok = child.localName === 'image' ? isSafeImageUrl(v) : v.startsWith('#');
        }
        if (!ok) {
          child.removeAttributeNode(attr);
          removed += 1;
        }
      }
      walk(child);
    }
  };
  walk(root);
  return removed;
}

/**
 * A prototype for an SVG avatar: parse, sanitize, and return its `.critter` group.
 * Throws when the file is not SVG or lacks the contract (.critter, one .shell).
 */
export function buildSvgProto(doc, avatar) {
  const parsed = new DOMParser().parseFromString(avatar.svg, 'image/svg+xml');
  if (parsed.getElementsByTagName('parsererror').length > 0) throw new Error('not a well-formed SVG');
  const svg = parsed.documentElement;
  if (svg.namespaceURI !== SVG_NS || svg.localName !== 'svg') throw new Error('root is not <svg>');
  sanitizeSvg(svg);
  const found = svg.querySelector('g.critter');
  if (!found) throw new Error('no <g class="critter">');
  if (found.querySelectorAll('.shell').length !== 1) throw new Error('needs exactly one .shell');
  const critter = doc.importNode(found, true);
  critter.removeAttribute('id');
  critter.setAttribute('data-kind', 'svg');
  critter.setAttribute('data-avatar', avatar.id);
  if (!critter.getAttribute('data-state')) critter.setAttribute('data-state', 'IDLE');
  return critter;
}

// ---- CSS -------------------------------------------------------------------------------

// The token list lives in avatar-format.json (cssForbidden) for the tooling and the
// importer; a conformance test keeps this regex covering every token.
export const FORBIDDEN_CSS = /@import|@font-face|@namespace|@charset|javascript:|expression\s*\(|<\/|\\/i;

/** The @keyframes names a stylesheet defines (before scoping renames them). */
export function keyframeNames(css) {
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  return new Set([...text.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
}

function scopeSelector(sel, scope) {
  const s = sel.trim();
  if (!s) throw new Error('empty selector');
  if (/:root|\bhtml\b|\bbody\b/i.test(s)) throw new Error(`selector out of scope: ${s}`);
  // `.critter…` is the creature itself; anything else is inside it.
  return /^\.critter(?![\w-])/.test(s) ? scope + s.slice('.critter'.length) : `${scope} ${s}`;
}

/**
 * Make an avatar's stylesheet apply to that avatar only: every selector under
 * `.critter[data-avatar="<id>"]`, every @keyframes renamed `av-<id>-<name>`. Only plain
 * rules and @keyframes are allowed. Throws on anything else.
 */
export function scopeCss(css, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new Error('bad avatar id');
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  if (FORBIDDEN_CSS.test(text)) throw new Error('@import, @font-face, escapes and javascript: are not allowed');
  if (!safeValue(text)) throw new Error('url() may only point to #id');
  const scope = `.critter[data-avatar="${id}"]`;
  const names = [...text.matchAll(/@keyframes\s+([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  const rename = (body) => names.reduce(
    (acc, n) => acc.replace(new RegExp(`(^|[^\\w-])${n}(?![\\w-])`, 'g'), `$1av-${id}-${n}`), body);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) {
      if (text.slice(i).trim()) throw new Error('trailing text outside a rule');
      break;
    }
    const head = text.slice(i, open).trim();
    if (head.startsWith('@')) {
      const m = /^@keyframes\s+([A-Za-z_][\w-]*)$/.exec(head);
      if (!m) throw new Error(`at-rule not allowed: ${head.split(/\s/)[0]}`);
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') depth -= 1;
        j += 1;
      }
      if (depth !== 0) throw new Error('unbalanced braces');
      out += `@keyframes av-${id}-${m[1]} ${text.slice(open, j)}\n`;
      i = j;
      continue;
    }
    const close = text.indexOf('}', open);
    if (close < 0 || text.slice(open + 1, close).includes('{')) throw new Error('unbalanced or nested braces');
    const selectors = head.split(',').map((sel) => scopeSelector(sel, scope));
    out += `${selectors.join(', ')} {${rename(text.slice(open + 1, close))}}\n`;
    i = close + 1;
  }
  return out;
}
