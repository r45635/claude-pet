/**
 * A minimal Chrome DevTools Protocol client for the media scripts (media.ts, demo-video.ts):
 * start headless Chrome, send a command and await its reply, wait for an event. No dependency.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Cdp = {
  send: (method: string, params?: object) => Promise<any>;
  /** Resolves on the next event of that name. */
  once: (event: string) => Promise<any>;
  close: () => void;
};

export async function connect(port: number): Promise<Cdp> {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
        let id = 0;
        const pending = new Map<number, (v: any) => void>();
        const waiting = new Map<string, ((v: any) => void)[]>();
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)!(msg.result ?? msg.error);
            pending.delete(msg.id);
          } else if (msg.method && waiting.has(msg.method)) {
            for (const resolve of waiting.get(msg.method)!) resolve(msg.params);
            waiting.delete(msg.method);
          }
        };
        return {
          send: (method, params = {}) => new Promise((ok) => {
            const n = ++id;
            pending.set(n, ok);
            ws.send(JSON.stringify({ id: n, method, params }));
          }),
          once: (event) => new Promise((ok) => waiting.set(event, [...(waiting.get(event) ?? []), ok])),
          close: () => ws.close(),
        };
      }
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

/** Headless Chrome with a throwaway profile; `stop` cleans both up. */
export async function launch(): Promise<{ cdp: Cdp; stop: () => Promise<void> }> {
  const profile = mkdtempSync(join(tmpdir(), 'pet-chrome-'));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome: ChildProcess = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const cdp = await connect(port);
  return {
    cdp,
    stop: async () => {
      cdp.close();
      chrome.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
