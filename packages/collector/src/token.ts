/**
 * The shared secret between the daemon and the widget, persisted so that either side can
 * restart — or start first at login — without the other going deaf.
 *
 * Read-or-create, race-free: the token is written to a private temp file and then
 * hard-linked into place. `link()` fails if the target exists, so exactly one creator
 * wins, and a reader can never observe a half-written file. The widget (Rust) does the
 * same dance on the same path; see apps/widget/src-tauri/src/main.rs.
 */

import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOKEN_FILE } from './paths.ts';

const TOKEN_RE = /^[0-9a-f]{24,}$/;

export function readOrCreateToken(file = TOKEN_FILE): string {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(existing)) return existing;
    unlinkSync(file); // corrupt or foreign content: replace it rather than trust it
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString('hex');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  try {
    linkSync(tmp, file);
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return readFileSync(file, 'utf8').trim(); // someone else won the race
  } finally {
    unlinkSync(tmp);
  }
}
