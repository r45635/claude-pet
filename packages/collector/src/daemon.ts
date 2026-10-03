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
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSpool, rotateIfNeeded } from './spool.ts';
import { ROOT_DIR, SPOOL_FILE } from './paths.ts';
import { Runtime } from './runtime.ts';

const PORT = Number(process.env.CLAUDE_PET_PORT ?? 8787);
const TOKEN = process.env.CLAUDE_PET_TOKEN ?? randomBytes(12).toString('hex');

/** 100 ms while events flow, 1 s when idle — an always-on widget must cost nothing. */
const TICK_BUSY_MS = 100;
const TICK_IDLE_MS = 1_000;
const IDLE_AFTER_QUIET_TICKS = 50;

ensureSpool();
const runtime = new Runtime({ spoolFile: SPOOL_FILE, fromStart: false });

const clients = new Set<ServerResponse>();
let quietTicks = 0;
let tickMs = TICK_IDLE_MS;
let timer: NodeJS.Timeout | undefined;
let lastEventAt = 0;

function tick(): void {
  const read = runtime.pump();
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
  const frame = `data: ${JSON.stringify(runtime.snapshot())}\n\n`;
  for (const client of clients) client.write(frame);
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
    res.end(JSON.stringify(runtime.snapshot()));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify(runtime.snapshot())}\n\n`);
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
  process.stderr.write(`claude-pet daemon on http://127.0.0.1:${PORT} (token ${TOKEN})\n`);
  process.stderr.write(`  curl -s "http://127.0.0.1:${PORT}/snapshot?token=${TOKEN}" | jq .\n`);
  schedule();
  setInterval(() => rotateIfNeeded(SPOOL_FILE), 60_000);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const client of clients) client.end();
    server.close(() => process.exit(0));
  });
}
