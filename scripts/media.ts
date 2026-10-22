#!/usr/bin/env node
/**
 * The README's pictures, from the real page: headless Chrome renders the browser harness
 * (apps/widget/web/index.html#demo=avatar…), frames are captured in real time over the
 * DevTools protocol, and ffmpeg turns them into GIFs (or keeps one frame as a PNG).
 *
 *   node scripts/media.ts            → docs/media/*.gif, *.png
 *
 * Needs Google Chrome, ffmpeg, and the avatar library cloned next to this repo
 * (../claude-pet-avatars) for the avatar scenes. Nothing personal is on screen: every
 * scene is the harness's synthetic data.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, sleep, type Cdp } from './cdp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'media');
const PAGE = `file://${join(ROOT, 'apps', 'widget', 'web', 'index.html')}`;
const BG = '#1e2230';

type Scene = { name: string; hash: string; w: number; h: number; seconds?: number; still?: boolean };

const SCENES: Scene[] = [
  { name: 'hero', hash: 'state=CODING&kids=3&gauge=42&size=230', w: 300, h: 260, seconds: 4 },
  { name: 'sessions', hash: 'sessions=CODING,WAITING,THINKING,READING&kids=2&state=TOOL_CALL&gauge=63&size=250', w: 300, h: 290, seconds: 4 },
  { name: 'storm', hash: 'state=HIGH_LOAD&kids=4&size=230', w: 300, h: 260, seconds: 3 },
  { name: 'tired', hash: 'state=CODING&ctx=93&size=170', w: 200, h: 200, seconds: 3 },
  ...['IDLE', 'THINKING', 'READING', 'CODING', 'TOOL_CALL', 'WAITING', 'DONE', 'ERROR'].map((st) =>
    ({ name: `state-${st.toLowerCase()}`, hash: `state=${st}&size=150`, w: 170, h: 170, still: true })),
  ...['ghost', 'alien', 'mint', 'cowboy', 'halloween', 'noel'].map((id) =>
    ({ name: `avatar-${id}`, hash: `avatar=${id}&state=CODING&size=150`, w: 170, h: 170, seconds: 2.5 })),
];

/**
 * The repository's social preview (GitHub → Settings → Social preview): 1280×640, the
 * creatures on the right, the pitch on the left. Same harness, one frame, composed in a page.
 */
async function socialPreview(cdp: Cdp): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 560, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await cdp.send('Page.navigate', { url: `${PAGE}#demo=avatar&lang=en&bg=${encodeURIComponent(BG)}&state=CODING&kids=3&gauge=42&size=470` });
  await sleep(2_500);
  const art = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data as string;
  const html = `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: 1280px; height: 640px; background: ${BG}; overflow: hidden; }
    body { display: flex; align-items: center; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    .text { flex: 1; padding: 0 0 0 96px; color: #eceff4; }
    h1 { font-size: 92px; margin: 0 0 18px; letter-spacing: -2px; }
    h1 span { color: #8fb8ff; }
    p { font-size: 34px; line-height: 1.35; margin: 0 0 34px; color: #c9d1d9; max-width: 640px; }
    .tags { font-size: 24px; color: #9aa3b5; }
    .tags b { color: #c9a2ff; font-weight: 600; }
    img { width: 560px; height: 560px; margin-right: 40px; }
  </style><div class="text"><h1>claude<span>-pet</span></h1>
  <p>A tiny creature on your Mac that shows what Claude Code is doing — right now.</p>
  <div class="tags"><b>thinking</b> · <b>coding</b> · <b>storming</b> · <b>waiting for you</b></div></div>
  <img src="data:image/png;base64,${art}">`;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await sleep(1_000);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'social-preview.png'), Buffer.from(data, 'base64'));
  process.stdout.write('social-preview\n');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { cdp, stop } = await launch();
  try {
    await cdp.send('Page.enable');
    for (const scene of SCENES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: scene.w, height: scene.h, deviceScaleFactor: 2, mobile: false });
      await cdp.send('Page.navigate', { url: 'about:blank' });
      await sleep(150);
      await cdp.send('Page.navigate', { url: `${PAGE}#demo=avatar&lang=en&bg=${encodeURIComponent(BG)}&${scene.hash}` });
      let title = '';
      for (let i = 0; i < 60 && !title.startsWith('ready') && !title.startsWith('failed'); i++) {
        await sleep(100);
        title = (await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result.value;
      }
      if (!title.startsWith('ready')) throw new Error(`${scene.name}: ${title || 'never ready'}`);
      await sleep(900); // the enter one-shots and the first steps
      const frames = mkdtempSync(join(tmpdir(), `pet-${scene.name}-`));
      const fps = 15;
      const count = scene.still ? 1 : Math.round((scene.seconds ?? 3) * fps);
      const t0 = Date.now();
      for (let i = 0; i < count; i++) {
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(frames, `f${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
        await sleep(Math.max(0, t0 + ((i + 1) * 1000) / fps - Date.now()));
      }
      if (scene.still) {
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(frames, 'f0000.png'), '-vf', 'scale=iw/2:-1:flags=lanczos', join(OUT, `${scene.name}.png`)]);
      } else {
        // Real-time capture, so the measured rate is the playback rate; half resolution, one shared palette.
        const real = count / ((Date.now() - t0) / 1000);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', real.toFixed(2), '-i', join(frames, 'f%04d.png'),
          '-vf', 'scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a',
          '-loop', '0', join(OUT, `${scene.name}.gif`)]);
      }
      rmSync(frames, { recursive: true, force: true });
      process.stdout.write(`${scene.name}\n`);
    }
    await socialPreview(cdp);
  } finally {
    await stop();
  }
}

await main();
