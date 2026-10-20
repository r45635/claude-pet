/**
 * Sprite sheet → image avatar: cut a grid of frames, one row per state, and write each row
 * as an animated PNG (APNG, which the format accepts and the widget plays as is), plus the
 * manifest. Pure Node (zlib), no image library, so it can be read like the rest.
 *
 *   npm run avatar -- from-sheet <sheet.png> <out-folder> --cell 192x208 --id robo --name Robo \
 *     --map IDLE=0,THINKING=1:6,CODING=2,ERROR=5:4 [--fps 8] [--license MIT] [--author "You"]
 *
 * `STATE=row` takes the row's frames up to the first empty cell; `STATE=row:n` takes n.
 * A one-frame row becomes a plain PNG. Only 8-bit RGB/RGBA, non-interlaced PNG sheets are
 * read; convert anything else first (`sips -s format png sheet.webp --out sheet.png`).
 *
 * The hitbox and the anchors (feet, why bubble) come from the IDLE frame's opaque pixels,
 * placed as the widget draws a picture: fitted into the 160×160 box, bottom-aligned.
 * Only use a sheet you are allowed to redistribute, and say so in `--license`.
 */

import { deflateSync, inflateSync, crc32 } from 'node:zlib';

export type Image = { width: number; height: number; rgba: Uint8Array };

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const buf = Buffer.from(png);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  const out: { type: string; data: Uint8Array }[] = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    out.push({ type, data: buf.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** 8-bit RGB or RGBA, non-interlaced → RGBA. Anything else is refused with what to do. */
export function decodePng(png: Uint8Array): Image {
  const all = chunks(png);
  const ihdr = Buffer.from(all.find((c) => c.type === 'IHDR')?.data ?? []);
  if (ihdr.length < 13) throw new Error('PNG without a header');
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, color, , , interlace] = ihdr.subarray(8, 13);
  const channels = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (depth !== 8 || channels === 0 || interlace !== 0) {
    throw new Error('only 8-bit RGB/RGBA non-interlaced PNG sheets: convert first (sips -s format png …)');
  }
  const raw = inflateSync(Buffer.concat(all.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
      if (pred === undefined) throw new Error(`bad PNG filter ${filter}`);
      pixels[y * stride + x] = (line[x] + pred) & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(pixels.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function crop(img: Image, x0: number, y0: number, w: number, h: number): Image {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    rgba.set(img.rgba.subarray(from, from + w * 4), y * w * 4);
  }
  return { width: w, height: h, rgba };
}

/** The opaque pixels' bounding box (alpha > 16), or null for an empty cell. */
export function opaqueBox(img: Image): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.rgba[(y * img.width + x) * 4 + 3]! > 16) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function scanlines(img: Image): Buffer {
  const out = Buffer.alloc(img.height * (img.width * 4 + 1));
  for (let y = 0; y < img.height; y++) out.set(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), y * (img.width * 4 + 1) + 1);
  return deflateSync(out, { level: 9 });
}

/** One frame → PNG; several → APNG looping forever at `fps`. Deterministic bytes. */
export function encodePng(frames: Image[], fps = 8): Buffer {
  const { width, height } = frames[0]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [SIGNATURE, chunk('IHDR', ihdr)];
  if (frames.length === 1) {
    parts.push(chunk('IDAT', scanlines(frames[0]!)));
  } else {
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(frames.length, 0); // frames; plays = 0: forever
    parts.push(chunk('acTL', actl));
    let seq = 0;
    frames.forEach((frame, i) => {
      const fctl = Buffer.alloc(26);
      fctl.writeUInt32BE(seq++, 0);
      fctl.writeUInt32BE(width, 4);
      fctl.writeUInt32BE(height, 8);
      fctl.writeUInt16BE(1, 20); // delay = 1 / fps s
      fctl.writeUInt16BE(fps, 22);
      fctl[24] = 1; // dispose: clear to transparent
      parts.push(chunk('fcTL', fctl));
      const data = scanlines(frame);
      if (i === 0) {
        parts.push(chunk('IDAT', data));
      } else {
        const n = Buffer.alloc(4);
        n.writeUInt32BE(seq++);
        parts.push(chunk('fdAT', Buffer.concat([n, data])));
      }
    });
  }
  parts.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

export type SheetOptions = {
  cell: { w: number; h: number };
  /** STATE → row, and how many frames (default: up to the first empty cell). */
  map: Record<string, { row: number; frames?: number }>;
  fps?: number;
  id: string;
  name: string;
  license?: string;
  author?: string;
};

/** The avatar folder's content: manifest and files. Validate it with the usual tooling. */
export function sheetToAvatar(sheet: Image, o: SheetOptions): { manifest: Record<string, unknown>; files: Map<string, Buffer> } {
  if (!o.map.IDLE) throw new Error('the map needs an IDLE row');
  const cols = Math.floor(sheet.width / o.cell.w);
  const rows = Math.floor(sheet.height / o.cell.h);
  const files = new Map<string, Buffer>();
  const states: Record<string, string> = {};
  for (const [state, { row, frames }] of Object.entries(o.map)) {
    if (row < 0 || row >= rows) throw new Error(`${state}: row ${row} is outside the sheet (${rows} rows)`);
    const cells: Image[] = [];
    for (let c = 0; c < (frames ?? cols) && c < cols; c++) {
      const cell = crop(sheet, c * o.cell.w, row * o.cell.h, o.cell.w, o.cell.h);
      if (frames === undefined && !opaqueBox(cell)) break; // the row ends at its first empty cell
      cells.push(cell);
    }
    if (cells.length === 0) throw new Error(`${state}: row ${row} is empty`);
    const file = `${state.toLowerCase().replace(/_/g, '-')}.png`;
    files.set(file, encodePng(cells, o.fps ?? 8));
    states[state] = file;
  }
  // Where the drawing is in the 160 box (fitted, bottom-aligned, like the widget's <image>).
  const idle = crop(sheet, 0, o.map.IDLE.row * o.cell.h, o.cell.w, o.cell.h);
  const box = opaqueBox(idle) ?? { x0: 0, y0: 0, x1: o.cell.w - 1, y1: o.cell.h - 1 };
  const k = Math.min(160 / o.cell.w, 160 / o.cell.h);
  const ox = (160 - o.cell.w * k) / 2;
  const oy = 160 - o.cell.h * k;
  const X = (x: number) => Math.round(ox + x * k);
  const Y = (y: number) => Math.round(oy + y * k);
  const [l, r, t, b] = [X(box.x0), X(box.x1 + 1), Y(box.y0), Y(box.y1 + 1)];
  const cx = Math.round((l + r) / 2);
  const manifest: Record<string, unknown> = {
    format: 1, id: o.id, name: o.name, version: '1.0.0',
    ...(o.author ? { author: o.author } : {}), ...(o.license ? { license: o.license } : {}),
    kind: 'images', states,
    anchors: { feet: [cx, Math.min(158, b)], why: [Math.max(10, cx - 14), Math.max(10, t - 4)] },
    hitbox: { cx, cy: Math.round((t + b) / 2), rx: Math.max(10, Math.round((r - l) / 2)), ry: Math.max(10, Math.round((b - t) / 2)) },
  };
  return { manifest, files };
}

/** `IDLE=0,THINKING=1:6` → the map. */
export function parseMap(text: string): SheetOptions['map'] {
  const map: SheetOptions['map'] = {};
  for (const part of text.split(',').filter(Boolean)) {
    const m = /^([A-Z_]+)=(\d+)(?::(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`--map: "${part}" is not STATE=row or STATE=row:frames`);
    map[m[1]!] = { row: Number(m[2]), ...(m[3] ? { frames: Number(m[3]) } : {}) };
  }
  return map;
}
