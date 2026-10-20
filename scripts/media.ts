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

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal DevTools client: send a command, await its reply. */
async function connect(port: number) {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
        let id = 0;
        const pending = new Map<number, (v: any) => void>();
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result ?? msg.error); pending.delete(msg.id); }
        };
        return {
          send: (method: string, params: object = {}) => new Promise<any>((ok) => {
            const n = ++id;
            pending.set(n, ok);
            ws.send(JSON.stringify({ id: n, method, params }));
          }),
          close: () => ws.close(),
        };
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pet-media-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    const cdp = await connect(port);
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
    cdp.close();
  } finally {
    chrome.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
