#!/usr/bin/env node
/**
 * The local state API. Binds 127.0.0.1 only. The one exception to "nothing here reaches
 * the network": a daily release-update check against github.com (update.ts) — one HEAD
 * request carrying nothing but the URL, off with the `updatesCheck` setting
 * (docs/PRIVACY.md, docs/RISKS.md #12).
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
import { applyPatch, ConfigFileError, nativeOnlyKey, prefsOf, readUserFile, sanitizeEngine, validatePatch, writeUserFile, type Prefs } from './prefs.ts';
import { setLaunchAtLogin } from './login.ts';
import { STANDALONE, VERSION } from './entry.ts';
import { LOCAL_BUILD } from './widget.ts';
import { checkForUpdate, freshUpdateState, installStandalone, restartDetached } from './update.ts';

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

// The config as last read: the file's prefs, and what was wrong with it. An unreadable file
// keeps the last good config — and is never written over (prefs.ts, ConfigFileError).
let prefs: Prefs = prefsOf({});
let configWarnings: string[] = [];
let configInvalid = false;
let launchAtLoginApplied: boolean | null = null;

function loadConfig(): void {
  try {
    const { user, warnings } = sanitizeEngine(readUserFile());
    prefs = prefsOf(user);
    runtime.engine.setConfig(mergeConfig(user)); // hot: no restart, state kept
    configWarnings = warnings;
    configInvalid = false;
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    configWarnings = [err.message];
    configInvalid = true;
  }
  for (const w of configWarnings) process.stderr.write(`config: ${w}\n`);
  if (prefs.launchAtLogin !== launchAtLoginApplied) {
    launchAtLoginApplied = prefs.launchAtLogin;
    setLaunchAtLogin(prefs.launchAtLogin);
  }
}
loadConfig();

// Opt-in (settings panel). Off, nothing watches or opens the conversation files.
const transcript = new TranscriptSource();
function applyTranscriptPref(): void {
  const on = prefs.readTranscripts && !prefs.paused && transcript.start();
  if (!on) transcript.stop();
  runtime.engine.enableTranscriptSource(on);
}
applyTranscriptPref();

// Release updates: checked daily (update.ts), surfaced in every frame and in /health.
let update = freshUpdateState(STANDALONE ? 'standalone' : 'clone', !STANDALONE && existsSync(LOCAL_BUILD));
let autoTried: string | null = null; // one automatic attempt per detected version, no retry loop
async function updateCheckLoop(): Promise<void> {
  if (!prefs.updatesCheck) return;
  const before = JSON.stringify(update);
  update = await checkForUpdate(update);
  if (update.error) process.stderr.write(`${update.error}\n`);
  if (JSON.stringify(update) !== before) broadcast();
  // Automatic install: standalone only, and only a signed release (allowUnsigned stays false).
  if (prefs.updatesAuto && update.available && update.layout === 'standalone' && update.latest && autoTried !== update.latest) {
    autoTried = update.latest;
    await runInstall(update.latest, false);
  }
}

/** The one install path, automatic or from the menu. Failure is reported, never silent. */
async function runInstall(tag: string, allowUnsigned: boolean): Promise<void> {
  update = { ...update, installing: true, error: null, unsigned: false };
  broadcast();
  const result = await installStandalone(tag, { allowUnsigned });
  if (!result.ok) {
    // An unsigned release is not an error to hide: the menu offers a warned, manual install.
    update = { ...update, installing: false, error: result.error, unsigned: result.unsigned === true };
    process.stderr.write(`update: ${result.error}\n`);
    broadcast();
    return;
  }
  process.stderr.write(`update: ${tag} installed, restarting (previous version kept as app.old)\n`);
  update = { ...update, installing: false, available: false };
  broadcast();
  restartDetached();
}

/**
 * POST /update — install the detected release (standalone only). Body {} or
 * {"allowUnsigned":true}, the latter sent only after the native "unsigned" warning dialog.
 * Native-only, the whole route: only the menu's confirmation dialogs call it (isNative).
 */
async function postUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const refuse = (status: number, error: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error, update }));
  };
  if (!isNative(req)) return refuse(403, 'native_only');
  const body = await readBody(req);
  let allowUnsigned = false;
  try {
    allowUnsigned = JSON.parse(body || '{}').allowUnsigned === true;
  } catch {
    /* an empty or broken body is a plain install request */
  }
  if (update.layout !== 'standalone') return refuse(400, 'clone');
  if (update.installing) return refuse(409, 'installing');
  if (!update.available || !update.latest) return refuse(409, 'no_update');
  // Accepted now, reported over SSE: a download outlasts the menu's 5 s localhost call.
  res.writeHead(202, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
  void runInstall(update.latest, allowUnsigned);
}

/** What the widget receives: the engine snapshot plus the menu's preferences. */
function view(): string {
  return JSON.stringify({ ...runtime.snapshot(), version: VERSION, update, prefs, config: { invalid: configInvalid, warnings: configWarnings } });
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
  const nativeKey = nativeOnlyKey(patch);
  if (nativeKey && !isNative(req)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'native_only', key: nativeKey }));
    return;
  }
  let current: ReturnType<typeof readUserFile>;
  try {
    current = readUserFile();
  } catch (err) {
    if (!(err instanceof ConfigFileError)) throw err;
    // Writing now would replace the user's hand edits with {} + this patch: refuse.
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'config_invalid', detail: err.message }));
    return;
  }
  writeUserFile(applyPatch(current, patch));
  loadConfig();
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
  // The watcher can die on its own (directory removed): the engine must not keep trusting it.
  if (prefs.readTranscripts && !transcript.running) runtime.engine.enableTranscriptSource(false);
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

/**
 * The token proves "on this Mac", not "not the page": the widget's page holds it too. What
 * only the native side may do (turn the chat on, consent to an unsigned update…) also
 * requires this header, which Rust's localhost client sends (src-tauri/src/daemon.rs). A
 * webview cannot attach a custom header to a cross-origin request without a CORS
 * preflight, and the daemon refuses every preflight — so the page can never send it.
 */
const NATIVE_HEADER = 'x-claude-pet-native';
function isNative(req: IncomingMessage): boolean {
  return req.headers[NATIVE_HEADER] === '1';
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  // The widget runs from `tauri://localhost` (or `file://` for the browser harness), so
  // without this header EventSource is blocked as cross-origin. Wildcard is safe here:
  // CORS only decides who may *read* a response, and the token still gates every route.
  res.setHeader('access-control-allow-origin', '*');
  // No preflight is ever granted: that is what keeps custom headers (isNative) out of the
  // page's reach. Nothing legitimate needs one — the page only reads, via EventSource.
  if (req.method === 'OPTIONS') {
    res.writeHead(403);
    res.end();
    return;
  }

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
        config_invalid: configInvalid,
        config_warnings: configWarnings,
        version: VERSION,
        update,
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

  if (url.pathname === '/update' && req.method === 'POST') {
    void postUpdate(req, res);
    return;
  }

  // "Advanced settings…": open the file in the user's default text editor.
  if (url.pathname === '/open-config' && req.method === 'POST') {
    if (!existsSync(CONFIG_FILE)) writeUserFile({});
    writeReference(REFERENCE_FILE, runtime.engine.config, prefs, configWarnings);
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
  // Update checks: one soon (off the login path), then daily. Never on the tick path.
  setTimeout(() => void updateCheckLoop(), 30_000);
  setInterval(() => void updateCheckLoop(), 24 * 3_600_000);
});

// Hand edits to config.json ("Advanced settings…") apply live too. The directory is
// watched rather than the file: editors save by renaming over it, which ends a file watch.
let reloadTimer: NodeJS.Timeout | undefined;
watch(ROOT_DIR, (_event, name) => {
  if (name !== 'config.json') return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    loadConfig();
    applyTranscriptPref();
    broadcast();
  }, 200);
});

// The network sensor runs only while a turn is open: back-to-back one-shot samples
// (~5 s each) for the sessions the engine says are mid-turn. See net.ts for the cost.
const net = new NetSensor();
async function netLoop(): Promise<void> {
  for (;;) {
    const targets = prefs.paused || !prefs.netSensor ? [] : runtime.engine.sessionsToSample();
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
