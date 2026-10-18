#!/usr/bin/env node
/**
 * Sign release artifacts: for each file given, write `<file>.sig` — an ed25519 signature
 * over the file's exact bytes, base64, one line. CI runs it on tag builds with the
 * `RELEASE_SIGNING_KEY` secret (a PKCS8 PEM); the collector verifies with the public key
 * committed at packages/collector/src/release-pubkey.pem. See docs/RISKS.md #12 for what
 * this does and does not protect.
 *
 *   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.ts release/*.sha256
 */

import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const pem = process.env.RELEASE_SIGNING_KEY;
if (!pem) {
  process.stderr.write('sign-release: RELEASE_SIGNING_KEY is not set\n');
  process.exit(2);
}
const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: sign-release.ts <file>...\n');
  process.exit(2);
}
const key = createPrivateKey(pem);
for (const file of files) {
  const signature = sign(null, readFileSync(file), key).toString('base64');
  writeFileSync(`${file}.sig`, `${signature}\n`);
  process.stdout.write(`signed ${file}.sig\n`);
}
