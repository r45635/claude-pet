#!/usr/bin/env node
/**
 * Sign release artifacts with the `RELEASE_SIGNING_KEY` secret (a PKCS8 PEM). CI runs it in
 * the tag-only publish job; the collector verifies with the public key committed at
 * packages/collector/src/release-pubkey.pem. See docs/RISKS.md #12.
 *
 *   node scripts/sign-release.ts --release <tag> release/*.tar.gz
 *       for each archive, <archive>.manifest (packages/collector/src/manifest.ts: the tag, the
 *       file name and its SHA-256) and <archive>.manifest.sig — what installs since v0.5.5
 *       check — and, for installs before v0.5.5, <archive>.sha256.sig over its .sha256.
 *   CATALOG_SIGNING_KEY=… node scripts/sign-release.ts --catalog dist/index.json
 *       the avatar catalog, by its own key: <index>.catalog.sig over manifest.ts's catalog
 *       prefix + the index's bytes.
 *   node scripts/sign-release.ts <file>...
 *       a plain signature over each file's exact bytes (<file>.sig) — the avatar catalog for
 *       clients before v0.5.5.
 *
 * Every signature: ed25519, base64, one line.
 */

import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { catalogSignedBytes, manifestName, manifestText, parseManifest } from '../packages/collector/src/manifest.ts';

const args = process.argv.slice(2);
const secret = args[0] === '--catalog' ? 'CATALOG_SIGNING_KEY' : 'RELEASE_SIGNING_KEY';
const pem = process.env[secret];
if (!pem) {
  process.stderr.write(`sign-release: ${secret} is not set\n`);
  process.exit(2);
}
const key = createPrivateKey(pem);

function signFile(file: string, k: KeyObject): void {
  writeFileSync(`${file}.sig`, `${sign(null, readFileSync(file), k).toString('base64')}\n`);
  process.stdout.write(`signed ${file}.sig\n`);
}

if (args[0] === '--catalog') {
  const index = args[1];
  if (!index || args.length !== 2) {
    process.stderr.write('usage: sign-release.ts --catalog <index.json>\n');
    process.exit(2);
  }
  writeFileSync(`${index}.catalog.sig`, `${sign(null, catalogSignedBytes(readFileSync(index)), key).toString('base64')}\n`);
  process.stdout.write(`signed ${index}.catalog.sig\n`);
} else if (args[0] === '--release') {
  const tag = args[1] ?? '';
  const archives = args.slice(2);
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag) || archives.length === 0) {
    process.stderr.write('usage: sign-release.ts --release <vX.Y.Z> <archive>...\n');
    process.exit(2);
  }
  for (const archive of archives) {
    const text = manifestText({ tag, file: basename(archive), sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') });
    if (!parseManifest(text)) {
      process.stderr.write(`sign-release: ${archive} cannot be named in a manifest\n`);
      process.exit(1);
    }
    writeFileSync(manifestName(archive), text);
    signFile(manifestName(archive), key);
    if (existsSync(`${archive}.sha256`)) signFile(`${archive}.sha256`, key);
  }
} else {
  if (args.length === 0) {
    process.stderr.write('usage: sign-release.ts --release <tag> <archive>... | <file>...\n');
    process.exit(2);
  }
  for (const file of args) signFile(file, key);
}
