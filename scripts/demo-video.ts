#!/usr/bin/env node
/**
 * The demo video for social posts: ~25 s, captioned, square (1080×1080) and wide (1920×1080),
 * H.264 — what Reddit, X and LinkedIn autoplay. Every scene is the real page (the browser
 * harness, apps/widget/web/index.html#demo=avatar…) framed with a caption, rendered by headless
 * Chrome on **virtual time**: each frame advances the page exactly 1/30 s, so animations are
 * smooth whatever the capture speed. ffmpeg only encodes.
 *
 *   node scripts/demo-video.ts      → docs/media/demo-square.mp4, docs/media/demo-wide.mp4
 *
 * Needs Google Chrome, ffmpeg (libx264) and the avatar library cloned next to this repo.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, sleep, type Cdp } from './cdp.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'docs', 'media');
const HARNESS = `file://${join(ROOT, 'apps', 'widget', 'web', 'index.html')}`;
const BG = '#1e2230';
const FPS = 30;

/** A title card, or the harness with a caption. `hash` is the harness's demo parameters. */
type Scene = { seconds: number; title?: string; caption?: string; sub?: string; hash?: string;
                /** Captured in real time: compositor animations (the galaxy's rotation) ignore virtual time. */
                realtime?: boolean };

const SCENES: Scene[] = [
  { seconds: 2.5, title: 'claude<span>-pet</span>', sub: 'Live Claude Code status, right on your Mac.' },
  { seconds: 4, caption: 'See what Claude is doing — at a glance.', hash: 'state=CODING&kids=3&gauge=42' },
  ...['THINKING', 'READING', 'CODING', 'TOOL_CALL', 'DONE'].map((st) =>
    ({ seconds: 0.9, caption: 'Thinking · reading · coding · done.', hash: `state=${st}` })),
  { seconds: 4, caption: 'One creature per session. The one that needs you raises its hand.',
    hash: 'sessions=CODING,WAITING,THINKING,READING&kids=2&state=TOOL_CALL&gauge=63' },
  { seconds: 3, caption: 'Storms come with a reason.', hash: 'state=HIGH_LOAD&kids=4' },
  { seconds: 5, caption: 'Or a galaxy around what needs you. (4× speed)', realtime: true,
    hash: 'layout=gravity&orbitSpeed=4&state=CODING&sessions=CODING,THINKING,IDLE,DONE,READING' },
  { seconds: 3, caption: 'It gets tired as the context fills up.', hash: 'state=CODING&ctx=93' },
  ...['ghost', 'alien', 'cowboy', 'halloween'].map((id) =>
    ({ seconds: 1, caption: 'Make it yours — a whole library of avatars.', hash: `avatar=${id}&state=CODING` })),
  { seconds: 3.5, title: 'claude<span>-pet</span>', sub: 'Free and open source · macOS · github.com/r45635/claude-pet' },
];

const LAYOUTS = {
  square: { w: 1080, h: 1080, frame: 820, size: 600 },
  wide: { w: 1920, h: 1080, frame: 960, size: 700 },
} as const;
type Layout = keyof typeof LAYOUTS;

/** The page that frames one scene: caption and harness side by side (wide) or stacked (square). */
function compose(scene: Scene, layout: Layout): string {
  const L = LAYOUTS[layout];
  const wide = layout === 'wide';
  const text = scene.title
    ? `<div class="card"><h1>${scene.title}</h1><p>${scene.sub ?? ''}</p></div>`
    : `<div class="caption">${scene.caption}</div>
       <iframe src="${HARNESS}#demo=avatar&lang=en&bg=${encodeURIComponent(BG)}&size=${L.size}&${scene.hash}"></iframe>`;
  return `<!doctype html><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${L.w}px; height: ${L.h}px; background: ${BG}; overflow: hidden; color: #eceff4;
                 font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    body { display: flex; ${wide ? 'flex-direction: row-reverse; align-items: center; justify-content: center; gap: 40px;'
                                 : 'flex-direction: column; align-items: center; justify-content: center;'} }
    iframe { width: ${L.frame}px; height: ${L.frame}px; border: 0; }
    .caption { font-size: ${wide ? 60 : 54}px; font-weight: 700; line-height: 1.2; letter-spacing: -0.5px;
               ${wide ? 'width: 820px;' : 'width: 940px; text-align: center; margin-bottom: 10px;'} }
    .card { text-align: center; }
    h1 { font-size: ${wide ? 150 : 130}px; margin: 0 0 24px; letter-spacing: -3px; }
    h1 span { color: #8fb8ff; }
    p { font-size: ${wide ? 44 : 40}px; margin: 0 auto; color: #c9d1d9; max-width: ${wide ? 1400 : 900}px; line-height: 1.35; }
  </style>${text}`;
}

async function renderScene(cdp: Cdp, scene: Scene, layout: Layout, dir: string, page: string, first: number): Promise<number> {
  writeFileSync(page, compose(scene, layout));
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance' }); // real time while loading
  await cdp.send('Page.navigate', { url: `file://${page}?${first}` });
  await sleep(scene.hash?.includes('avatar=') ? 2_200 : 1_500); // the harness loads (and fetches an avatar)
  const frames = Math.round(scene.seconds * FPS);
  if (scene.realtime) {
    // Real time: capture as fast as it goes, and repeat each frame until the next one so the
    // video keeps FPS frames per second of wall time.
    const t0 = performance.now();
    let written = 0;
    while (written < frames) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const upTo = Math.min(frames, Math.max(written + 1, Math.round(((performance.now() - t0) / 1000) * FPS)));
      const png = Buffer.from(data, 'base64');
      for (; written < upTo; written++) writeFileSync(join(dir, `f${String(first + written).padStart(5, '0')}.png`), png);
    }
    return first + frames;
  }
  await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'pause' });
  for (let i = 0; i < frames; i++) {
    const done = cdp.once('Emulation.virtualTimeBudgetExpired');
    await cdp.send('Emulation.setVirtualTimePolicy', { policy: 'advance', budget: 1000 / FPS });
    await done;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(dir, `f${String(first + i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
  }
  return first + frames;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'pet-video-'));
  const { cdp, stop } = await launch();
  try {
    await cdp.send('Page.enable');
    for (const layout of Object.keys(LAYOUTS) as Layout[]) {
      const L = LAYOUTS[layout];
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: L.w, height: L.h, deviceScaleFactor: 1, mobile: false });
      const dir = join(work, layout);
      mkdirSync(dir);
      let n = 0;
      for (const scene of SCENES) n = await renderScene(cdp, scene, layout, dir, join(work, 'scene.html'), n);
      const out = join(OUT, `demo-${layout}.mp4`);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, 'f%05d.png'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', out]);
      process.stdout.write(`${out} (${n} frames)\n`);
    }
  } finally {
    await stop();
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
