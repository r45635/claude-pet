#!/usr/bin/env node
/**
 * The menu-bar icon: the creature's silhouette as a macOS *template* image — black on
 * transparent, which macOS recolours for light and dark menu bars. 44×44 px = 22 pt @2x.
 * Generated (supersampled shapes, no image library) so it can be reviewed as code and
 * rebuilt byte-identical:
 *
 *   node scripts/tray-icon.ts   → apps/widget/src-tauri/icons/tray.png
 */

import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';

const SIZE = 44;
const SS = 4; // samples per pixel, per axis

/** Coverage of one point: the body, antenna and bulb are ink; the eyes are holes. */
function ink(x: number, y: number): boolean {
  const inEllipse = (cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  const eye = inEllipse(17.5, 26, 2.2, 2.8) || inEllipse(26.5, 26, 2.2, 2.8);
  const body = inEllipse(22, 28, 13.5, 13) && y <= 39.5;
  const feet = inEllipse(16.5, 40, 4.2, 2.2) || inEllipse(27.5, 40, 4.2, 2.2);
  const antenna = Math.abs(x - 22) <= 1.1 && y >= 8 && y <= 16;
  const bulb = inEllipse(22, 6.5, 3.4, 3.4);
  return ((body && !eye) || feet || antenna || bulb);
}

const rows: Buffer[] = [];
for (let py = 0; py < SIZE; py++) {
  const row = Buffer.alloc(1 + SIZE * 4); // filter byte 0, then RGBA
  for (let px = 0; px < SIZE; px++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      if (ink(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hits += 1;
    }
    row[1 + px * 4 + 3] = Math.round((255 * hits) / (SS * SS)); // RGB stay 0: black
  }
  rows.push(row);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = new URL('../apps/widget/src-tauri/icons/tray.png', import.meta.url);
writeFileSync(out, png);
process.stdout.write(`${out.pathname} (${png.length} bytes)\n`);
