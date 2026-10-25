/**
 * The signed release manifest: what CI signs for each release archive, and what an install
 * checks before it touches anything.
 *
 *   claude-pet release manifest v1
 *   tag v0.5.5
 *   file claude-pet-aarch64-apple-darwin.tar.gz
 *   sha256 <64 hex>
 *
 * Signing the bare `.sha256` (the format before v0.5.5, still published for older clients)
 * bound an archive to a hash, not to a release: an old signed archive re-uploaded under a
 * new tag verified. The manifest names the tag and the file, so it cannot be replayed under
 * another release. Its first line is a domain prefix: no other signed thing (a `.sha256`, the
 * avatar catalog's JSON) can be read as a manifest.
 *
 * The avatar catalog is signed by its own key (catalog.ts), over CATALOG_SIG_HEADER followed
 * by index.json's bytes — the same kind of domain prefix.
 *
 * No imports beyond node:crypto: scripts/sign-release.ts uses this module in CI.
 */

import { createHash } from 'node:crypto';

export const MANIFEST_HEADER = 'claude-pet release manifest v1';
export const CATALOG_SIG_HEADER = 'claude-pet avatar catalog v1\n';

/** What the catalog key signs: the prefix, then the index exactly as published. */
export const catalogSignedBytes = (index: Buffer): Buffer => Buffer.concat([Buffer.from(CATALOG_SIG_HEADER), index]);

export type Manifest = { tag: string; file: string; sha256: string };

export const manifestName = (file: string): string => `${file}.manifest`;

export function manifestText({ tag, file, sha256 }: Manifest): string {
  return `${MANIFEST_HEADER}\ntag ${tag}\nfile ${file}\nsha256 ${sha256}\n`;
}

/** Exactly the four lines above, or null: no extra line, no other order, no other spelling. */
export function parseManifest(text: string): Manifest | null {
  const m = /^claude-pet release manifest v1\ntag (v\d+\.\d+\.\d+(?:-[\w.-]+)?)\nfile ([\w.-]+)\nsha256 ([0-9a-f]{64})\n$/.exec(text);
  return m ? { tag: m[1]!, file: m[2]!, sha256: m[3]! } : null;
}

/**
 * Null when `archive` is exactly what the (already signature-checked) manifest says for
 * release `tag`, file `file`; otherwise why not.
 */
export function manifestMismatch(archive: Buffer, text: string, want: { tag: string; file: string }): string | null {
  const m = parseManifest(text);
  if (!m) return 'the release manifest is malformed';
  if (m.tag !== want.tag) return `the release manifest is for ${m.tag}, not ${want.tag}`;
  if (m.file !== want.file) return `the release manifest is for ${m.file}, not ${want.file}`;
  if (createHash('sha256').update(archive).digest('hex') !== m.sha256) return 'SHA-256 does not match the signed manifest';
  return null;
}
