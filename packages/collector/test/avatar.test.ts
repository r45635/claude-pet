import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORMAT, checkManifest, isAnimated, sniff, validateDir } from '../src/avatar-format.ts';
// @ts-ignore — a plain browser module, typed by its JSDoc only.
import { resolveStates, scopeCss, isSafeImageUrl } from '../../../apps/widget/web/avatar.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function avatarDir(manifest: unknown, files: Record<string, Uint8Array | string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-pet-avatar-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
const images = (states: Record<string, string>) => ({ format: 1, id: 'demo', name: 'Demo', kind: 'images', states });

test('format: a minimal image avatar (IDLE only) is valid', () => {
  const r = validateDir(avatarDir(images({ IDLE: 'idle.png' }), { 'idle.png': PNG }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.files, ['idle.png']);
});

test('format: the shipped examples are valid', () => {
  const root = join(import.meta.dirname, '..', '..', '..', 'avatars');
  for (const id of readdirSync(root)) {
    const r = validateDir(join(root, id));
    assert.deepEqual(r.errors, [], id);
  }
});

test('format: refuses paths, unknown states, reserved ids, missing IDLE', () => {
  const errors: string[] = [];
  checkManifest({ format: 1, id: 'classic', name: 'x', kind: 'images',
                  states: { THINKING: '../../etc/passwd', NAPPING: 'a.png' } }, errors);
  const all = errors.join('\n');
  assert.match(all, /reserved/);
  assert.match(all, /IDLE.*required/);
  assert.match(all, /not a plain file name/);
  assert.match(all, /unknown state/);
});

test('format: license is optional and loosely checked (an SPDX identifier)', () => {
  const ok: string[] = [];
  checkManifest({ ...images({ IDLE: 'idle.png' }), license: 'MIT' }, ok);
  assert.deepEqual(ok, []);
  const bad: string[] = [];
  checkManifest({ ...images({ IDLE: 'idle.png' }), license: 42 }, bad);
  assert.match(bad.join(), /license/);
});

test('format: the content decides the type, not the extension', () => {
  const r = validateDir(avatarDir(images({ IDLE: 'idle.png' }), { 'idle.png': '<html><script>x</script>' }));
  assert.match(r.errors.join(), /content is unknown, not \.png/);
  assert.equal(sniff(PNG), 'png');
  assert.equal(sniff(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
});

test('format: oversized files are refused; an animated IDLE only warns', () => {
  const big = new Uint8Array(FORMAT.limits.fileBytes + 1);
  big.set(PNG);
  assert.match(validateDir(avatarDir(images({ IDLE: 'idle.png' }), { 'idle.png': big })).errors.join(), /larger than/);
  const apng = new Uint8Array([...PNG, ...new TextEncoder().encode('acTL')]);
  assert.ok(isAnimated('png', apng));
  const r = validateDir(avatarDir(images({ IDLE: 'idle.png' }), { 'idle.png': apng }));
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join(), /animated/);
});

test('format: a stylesheet may not reach outside the avatar', () => {
  const svgAvatar = { format: 1, id: 'demo', name: 'Demo', kind: 'svg', svg: 'c.svg', css: 's.css' };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="critter"/></svg>';
  for (const css of ['@import "x.css";', '.a { background: url(https://evil.example/p.png) }', '@font-face{}']) {
    assert.match(validateDir(avatarDir(svgAvatar, { 'c.svg': svg, 's.css': css })).errors.join(), /not allowed/, css);
  }
});

test('animations: a valid section passes; pictures may ship css', () => {
  const manifest = {
    ...images({ IDLE: 'idle.png' }),
    css: 'skin.css',
    animations: {
      profile: 'classic',
      states: {
        THINKING: { target: 'body', keyframes: 'bob', dur: 2600, ease: 'ease-in-out', amp: 1.2 },
        IDLE: { keyframes: null },
        DONE: { enter: { keyframes: 'tip', dur: 900, ease: [0.3, 0, 0.3, 1], count: 2 } },
        ERROR: { fallback: 'DONE' },
      },
    },
  };
  const r = validateDir(avatarDir(manifest, {
    'idle.png': PNG,
    'skin.css': '@keyframes bob { to { opacity: .9 } } @keyframes tip { to { opacity: .8 } }',
  }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.files, ['idle.png', 'skin.css']);
});

test('animations: unknown states, keys, targets and ranges are refused', () => {
  const cases: [unknown, RegExp][] = [
    [{ states: { NAP: { keyframes: 'x' } } }, /unknown state/],
    [{ states: { DONE: { target: 'tentacle', keyframes: 'x' } } }, /target/],
    [{ states: { DONE: { keyframes: 'a}body{' } } }, /keyframes/],
    [{ states: { DONE: { keyframes: 'x', dur: 999999999 } } }, /dur/],
    [{ states: { DONE: { keyframes: 'x', ease: 'bouncy' } } }, /ease/],
    [{ states: { DONE: { keyframes: 'x', amp: 99 } } }, /amp/],
    [{ states: { DONE: { enter: { keyframes: 'x', count: 0 } } } }, /count/],
    [{ states: { DONE: { fallback: 'NOPE' } } }, /fallback/],
    [{ states: { DONE: { fallback: 'DONE', dur: 500 } } }, /nothing else/],
    [{ states: { DONE: { keyframes: 'x', onload: 'evil' } } }, /unknown key/],
    [{ profile: 'vivid' }, /profile/],
    [[1], /object/],
  ];
  for (const [animations, why] of cases) {
    const errors: string[] = [];
    checkManifest({ ...images({ IDLE: 'idle.png' }), animations }, errors);
    assert.match(errors.join('\n'), why, JSON.stringify(animations));
  }
});

test('animations: a bound keyframes name must exist in the css or the built-ins', () => {
  const manifest = {
    ...images({ IDLE: 'idle.png' }),
    animations: { states: { THINKING: { keyframes: 'nowhere' }, DONE: { keyframes: 'breathe' } } },
  };
  const r = validateDir(avatarDir(manifest, { 'idle.png': PNG }));
  assert.match(r.errors.join('\n'), /THINKING.*"nowhere" is neither/);
  assert.ok(!r.errors.join('\n').includes('DONE'), 'a built-in name is fine');
});

test('states: every state resolves through the fallbacks to an image', () => {
  const r = resolveStates({ IDLE: 'i', ACTIVE: 'a', ERROR: 'e' }, FORMAT.fallback, FORMAT.states);
  assert.equal(r.THINKING, 'a');
  assert.equal(r.HIGH_LOAD, 'a');
  assert.equal(r.ERROR, 'e');
  assert.equal(r.WAITING, 'a', 'waiting on you is awake, not asleep');
  assert.equal(r.DONE, 'i');
  assert.equal(resolveStates({ IDLE: 'i' }, FORMAT.fallback, FORMAT.states).CODING, 'i');
});

test('css: every rule is scoped to the avatar and keyframes become private', () => {
  const out = scopeCss('.critter { --skin-base: red } .hat { fill: #000 }\n' +
    '.critter[data-state="DONE"] .hat { animation: tip 1s }\n@keyframes tip { 50% { opacity: 0 } }', 'mint');
  assert.match(out, /^\.critter\[data-avatar="mint"\] \{/m);
  assert.match(out, /\.critter\[data-avatar="mint"\] \.hat \{/);
  assert.match(out, /\.critter\[data-avatar="mint"\]\[data-state="DONE"\] \.hat \{ animation: av-mint-tip 1s/);
  assert.match(out, /@keyframes av-mint-tip/);
});

test('css: escapes, external url(), @media, :root and body are refused', () => {
  for (const css of ['.a { color: \\72 ed }', '.a { fill: url(http://x/y) }', '@media screen { .a {} }',
                     ':root { --ink: red }', 'body .a { }', '.a { b: c } }']) {
    assert.throws(() => scopeCss(css, 'demo'), css);
  }
  assert.doesNotThrow(() => scopeCss('.a { fill: url(#grad) }', 'demo'));
});

test('images: only base64 data: images may be shown', () => {
  assert.ok(isSafeImageUrl('data:image/png;base64,iVBORw0KGgo='));
  assert.ok(!isSafeImageUrl('https://example.com/x.png'));
  assert.ok(!isSafeImageUrl('data:text/html;base64,PHNjcmlwdD4='));
  assert.ok(!isSafeImageUrl('javascript:alert(1)'));
});
