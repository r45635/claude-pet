import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'daemon.ts');

/** One raw HTTP request, as any web page or local process could send it; the status line back. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(request));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

test('daemon: a malformed request target is a 400, never a crash; an empty token env is no token', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pet-daemon-'));
  writeFileSync(join(home, 'config.json'), '{"ui":{"sensors":{"net":false},"updates":{"check":false}}}\n');
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, CLAUDE_PET_HOME: home, CLAUDE_PET_PORT: String(port), CLAUDE_PET_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stderr.on('data', (d: Buffer) => { if (d.toString().includes('daemon on')) resolve(); });
      child.on('exit', (code) => reject(new Error(`daemon exited ${code}`)));
    });
    assert.match(await raw(port, `GET /health HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`), / 421 /,
                 'a rebound name is refused before anything else');
    assert.match(await raw(port, `GET //a:b HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), / 400 /);
    assert.equal(child.exitCode, null, 'still running');
    // CLAUDE_PET_TOKEN="" must not mean "the token is the empty string".
    assert.match(await raw(port, `GET /health?token= HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), / 401 /);
    assert.match(await raw(port, `GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), / 401 /);
  } finally {
    child.kill('SIGTERM');
  }
});
