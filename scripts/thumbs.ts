#!/usr/bin/env node
/**
 * The avatar menu's pictures (docs/AVATARS.md, "thumb"): headless Chrome draws each avatar in
 * the browser harness, at rest, on a transparent backdrop; the creature's own box, squared,
 * is captured at 128×128.
 *
 *   node scripts/thumbs.ts              → Classic: apps/widget/src-tauri/icons/classic-thumb.png
 *   node scripts/thumbs.ts <folder>...  → <folder>/thumb.png, and "thumb" in its manifest.json
 *
 * The folders are the library's (../claude-pet-avatars/avatars/<id>): the harness reads
 * avatars from there. Needs Google Chrome.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { launch, sleep, type Cdp } from './cdp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const PAGE = `file://${join(ROOT, 'apps', 'widget', 'web', 'index.html')}`;
const LIBRARY = resolve(ROOT, '..', 'claude-pet-avatars', 'avatars');
const SIDE = 128;
/**
 * Awake and smiling: DONE's face, without its badge and confetti. IDLE
 * sleeps (eyes shut, Zzz). A picture avatar without a DONE picture shows its ACTIVE one
 * (CODING falls back to it), else IDLE.
 */
function stateFor(folder: string | null): string {
  if (!folder) return 'DONE';
  const m = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
  return m.kind === 'images' && !m.states?.DONE ? 'CODING' : 'DONE';
}

async function thumb(cdp: Cdp, id: string, state: string): Promise<Buffer> {
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${PAGE}#demo=avatar&lang=en&bg=transparent&avatar=${id}&state=${state}&size=160` });
  let title = '';
  for (let i = 0; i < 60 && !title.startsWith('ready') && !title.startsWith('failed'); i++) {
    await sleep(100);
    title = (await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value;
  }
  if (!title.startsWith('ready')) throw new Error(`${id}: ${title || 'never ready'}`);
  await sleep(1_500); // the DONE one-shot plays out
  // The drawn creature's box (not the 160 box around it), squared, a little margin.
  const { result } = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      document.documentElement.style.background = 'transparent';
      // DONE's extras sit around the body: a shape of its layer centred outside the body's
      // ellipse (the hitbox) is hidden; the face, inside it, stays.
      const [cx, cy, rx, ry] = [80, 92, 48, 52];
      for (const el of document.querySelectorAll('#pet .opt.on-DONE :is(circle, ellipse, path, rect, text, polygon, line), #pet :is(circle, ellipse, path, rect, text, polygon, line).opt.on-DONE')) {
        const b = el.getBBox();
        const dx = (b.x + b.width / 2 - cx) / rx;
        const dy = (b.y + b.height / 2 - cy) / ry;
        if (dx * dx + dy * dy > 1) el.style.display = 'none';
      }
      const r = document.querySelector('#pet .critter:not(#critter-proto)')?.getBoundingClientRect()
        ?? document.querySelector('#pet').getBoundingClientRect();
      const side = Math.max(r.width, r.height) * 1.06;
      return { x: r.x + r.width / 2 - side / 2, y: r.y + r.height / 2 - side / 2, side };
    })()`,
  });
  const box = result.value as { x: number; y: number; side: number };
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.side, height: box.side, scale: SIDE / box.side },
  });
  return Buffer.from(data, 'base64');
}

async function main(): Promise<void> {
  const folders = process.argv.slice(2).map((f) => resolve(f));
  for (const folder of folders) {
    if (resolve(folder, '..') !== LIBRARY) throw new Error(`${folder}: not an avatar folder of ${LIBRARY}`);
  }
  const { cdp, stop } = await launch();
  try {
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 220, height: 220, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    // Still: no breathing or blinking caught half-way.
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    if (folders.length === 0) {
      const out = join(ROOT, 'apps', 'widget', 'src-tauri', 'icons', 'classic-thumb.png');
      writeFileSync(out, await thumb(cdp, 'classic', stateFor(null)));
      process.stdout.write(`classic → ${out}\n`);
    }
    for (const folder of folders) {
      const id = basename(folder);
      writeFileSync(join(folder, 'thumb.png'), await thumb(cdp, id, stateFor(folder)));
      const path = join(folder, 'manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.thumb !== 'thumb.png') {
        manifest.thumb = 'thumb.png';
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      }
      process.stdout.write(`${id} → ${join(folder, 'thumb.png')}\n`);
    }
  } finally {
    await stop();
  }
}

await main();
