#!/usr/bin/env node
/**
 * The local state API. Binds 127.0.0.1 only; nothing in this file can reach the network.
 *
 *   GET /snapshot          one-shot JSON
 *   GET /events            Server-Sent Events, one `data:` frame per tick
 *   GET /health            liveness + whether events are actually arriving
 *
 * SSE (not WebSocket) because the feed is one-way and `EventSource` reconnects for free
 * in the Tauri webview. See docs/ARCHITECTURE.md.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSpool, rotateIfNeeded } from './spool.ts';
import { ROOT_DIR, SPOOL_FILE } from './paths.ts';
import { Runtime } from './runtime.ts';
import { readOrCreateToken } from './token.ts';
import { NetSensor } from './net.ts';
import { TranscriptSource } from './transcript.ts';
import { execFile } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { mergeConfig } from '@claude-pet/core';
import { CONFIG_FILE, REFERENCE_FILE } from './paths.ts';
import { writeReference } from './reference.ts';
import { applyPatch, prefsOf, readUserFile, validatePatch, writeUserFile, type Prefs } from './prefs.ts';

const PORT = Number(process.env.CLAUDE_PET_PORT ?? 8787);
// Persistent (~/.claude-pet/token) so a daemon restart does not orphan a running widget.
const TOKEN = process.env.CLAUDE_PET_TOKEN ?? readOrCreateToken();

/** 100 ms while events flow, 1 s when idle — an always-on widget must cost nothing. */
const TICK_BUSY_MS = 100;
const TICK_IDLE_MS = 1_000;
const IDLE_AFTER_QUIET_TICKS = 50;

ensureSpool();
const runtime = new Runtime({ spoolFile: SPOOL_FILE, warmStartMs: 2 * 60 * 60_000 }); // turns can run for an hour

const clients = new Set<ServerResponse>();
let prefs: Prefs = prefsOf(readUserFile());

// Opt-in (settings panel). Off, nothing watches or opens the conversation files.
const transcript = new TranscriptSource();
function applyTranscriptPref(): void {
  const on = prefs.readTranscripts && !prefs.paused && transcript.start();
  if (!on) transcript.stop();
  runtime.engine.enableTranscriptSource(on);
}
applyTranscriptPref();

/** What the widget receives: the engine snapshot plus the menu's preferences. */
function view(): string {
  return JSON.stringify({ ...runtime.snapshot(), prefs });
}

function broadcast(): void {
  const frame = `data: ${view()}\n\n`;
  for (const client of clients) client.write(frame);
}

function readBody(req: IncomingMessage, limit = 4_096): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        resolve(null);
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', () => resolve(null));
  });
}

/**
 * POST /config — a patch from the right-click menu. Body is JSON sent as text/plain, so
 * the browser makes a "simple" request with no CORS preflight; the token still gates it.
 */
async function updateConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let patch: ReturnType<typeof validatePatch>;
  try {
    patch = validatePatch(body === null ? null : JSON.parse(body));
  } catch {
    patch = { error: 'body is not JSON' };
  }
  if ('error' in patch) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(patch));
    return;
  }
  const user = applyPatch(readUserFile(), patch);
  writeUserFile(user);
  prefs = prefsOf(user);
  runtime.engine.setConfig(mergeConfig(user)); // hot: no restart, state kept
  applyTranscriptPref();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(prefs));
  broadcast();
}
let quietTicks = 0;
let tickMs = TICK_IDLE_MS;
let timer: NodeJS.Timeout | undefined;
let lastEventAt = 0;

function tick(): void {
  const read = runtime.pump() + transcript.drain((signal) => runtime.engine.ingestTranscript(signal));
  if (read > 0) {
    quietTicks = 0;
    lastEventAt = Date.now();
  } else {
    quietTicks += 1;
  }

  const wanted = quietTicks > IDLE_AFTER_QUIET_TICKS ? TICK_IDLE_MS : TICK_BUSY_MS;
  if (wanted !== tickMs) {
    tickMs = wanted;
    schedule();
  }

  if (clients.size === 0) return;
  broadcast();
}

function schedule(): void {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, tickMs);
}

function authorized(url: URL): boolean {
  return url.searchParams.get('token') === TOKEN;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  // The widget runs from `tauri://localhost` (or `file://` for the browser harness), so
  // without this header EventSource is blocked as cross-origin. Wildcard is safe here:
  // CORS only decides who may *read* a response, and the token still gates every route.
  res.setHeader('access-control-allow-origin', '*');

  if (!authorized(url)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"token required"}');
    return;
  }

  if (url.pathname === '/health') {
    const snapshot = runtime.snapshot();
    // A 200 proves the server runs. These counters are what prove it is being fed.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        spool: SPOOL_FILE,
        spool_offset: runtime.tailer.offset,
        events_seen: snapshot.debug.events_seen,
        events_dropped: snapshot.debug.events_dropped,
        last_event_at: lastEventAt > 0 ? new Date(lastEventAt).toISOString() : null,
        sources: snapshot.sources,
        clients: clients.size,
        tick_ms: tickMs,
      }),
    );
    return;
  }

  if (url.pathname === '/snapshot') {
    runtime.pump();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(view());
    return;
  }

  // Widget diagnostics: the page reports menu actions and fetch failures here, since a
  // release webview has no console. One short line in the daemon log, nothing stored.
  if (url.pathname === '/log') {
    const message = (url.searchParams.get('m') ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
    process.stderr.write(`widget: ${message}\n`);
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/config' && req.method === 'POST') {
    process.stderr.write(`config: POST from ${req.headers.origin ?? 'no origin'}\n`);
    void updateConfig(req, res);
    return;
  }

  if (url.pathname === '/config') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(prefs));
    return;
  }

  // "Advanced settings…": open the file in the user's default text editor.
  if (url.pathname === '/open-config' && req.method === 'POST') {
    if (!existsSync(CONFIG_FILE)) writeUserFile(readUserFile());
    writeReference(REFERENCE_FILE, runtime.engine.config, prefs.temperament);
    execFile('open', ['-t', CONFIG_FILE, REFERENCE_FILE], () => {});
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${view()}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
}

const server = createServer(handle);

server.listen(PORT, '127.0.0.1', () => {
  // The widget reads this file to learn the URL; 0600, inside the 0700 root.
  writeFileSync(
    join(ROOT_DIR, 'endpoint.json'),
    JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token: TOKEN }),
    { mode: 0o600 },
  );
  // The token is never logged: it lives in ~/.claude-pet/token (0600), nowhere else.
  process.stderr.write(`claude-pet daemon on http://127.0.0.1:${PORT}\n`);
  process.stderr.write(`  curl -s "http://127.0.0.1:${PORT}/snapshot?token=$(cat ~/.claude-pet/token)" | jq .\n`);
  schedule();
  setInterval(() => rotateIfNeeded(SPOOL_FILE), 60_000);
});

// Hand edits to config.json ("Advanced settings…") apply live too. The directory is
// watched rather than the file: editors save by renaming over it, which ends a file watch.
let reloadTimer: NodeJS.Timeout | undefined;
watch(ROOT_DIR, (_event, name) => {
  if (name !== 'config.json') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const user = readUserFile();
    prefs = prefsOf(user);
    runtime.engine.setConfig(mergeConfig(user));
    applyTranscriptPref();
    broadcast();
  }, 200);
});

// The network sensor runs only while a turn is open: back-to-back one-shot samples
// (~5 s each) for the sessions the engine says are mid-turn. See net.ts for the cost.
const net = new NetSensor();
async function netLoop(): Promise<void> {
  for (;;) {
    const targets = prefs.paused ? [] : runtime.engine.sessionsToSample();
    if (targets.length === 0) {
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    const sample = await net.sample(Date.now);
    if (sample === null) return; // sensor unavailable on this machine
    const now = Date.now();
    for (const { sid, ppid } of targets) {
      const pid = await net.claudePidOf(ppid);
      const delta = pid === null ? undefined : sample.get(pid);
      // No delta (first sighting, counter reset, no socket): say nothing; the last sample
      // goes stale and the engine falls back to its unmeasured behaviour.
      if (delta) runtime.engine.ingestNet(sid, delta.bytesIn, delta.spanMs, now);
    }
  }
}
void netLoop();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const client of clients) client.end();
    server.close(() => process.exit(0));
  });
}
