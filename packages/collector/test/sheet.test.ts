import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng, opaqueBox, parseMap, sheetToAvatar, type Image } from '../../../scripts/sheet.ts';
import { isAnimated, validateDir } from '../src/avatar-format.ts';

/** A 4×3 grid of 20×24 cells: row r, column c holds a square (row 1 has 3 frames, then empty cells). */
function sheet(): Image {
  const [w, h, cols, rows] = [20, 24, 4, 3];
  const img = { width: w * cols, height: h * rows, rgba: new Uint8Array(w * cols * h * rows * 4) };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (r === 1 && c >= 3) continue;
    for (let y = 6 + c; y < 20; y++) for (let x = 4; x < 16; x++) {
      const i = ((r * h + y) * img.width + c * w + x) * 4;
      img.rgba.set([40 * r, 60 * c, 200, 255], i);
    }
  }
  return img;
}

test('sheet: PNG round trip, and the format\'s own validator accepts the result', () => {
  const img = sheet();
  const decoded = decodePng(encodePng([img]));
  assert.deepEqual([decoded.width, decoded.height], [80, 72]);
  assert.deepEqual(Buffer.from(decoded.rgba), Buffer.from(img.rgba));

  const { manifest, files } = sheetToAvatar(decoded, { cell: { w: 20, h: 24 }, map: parseMap('IDLE=0:1,THINKING=1,ERROR=2:2'),
                                                       id: 'grid', name: 'Grid', license: 'MIT' });
  assert.deepEqual(manifest.states, { IDLE: 'idle.png', THINKING: 'thinking.png', ERROR: 'error.png' });
  assert.equal(isAnimated('png', files.get('idle.png')!), false, 'one frame: a plain PNG');
  assert.equal(isAnimated('png', files.get('thinking.png')!), true, 'a row: an animated PNG');
  const thinking = files.get('thinking.png')!;
  assert.equal(thinking.readUInt32BE(thinking.indexOf('acTL') + 4), 3, 'the row stops at its first empty cell');

  const dir = mkdtempSync(join(tmpdir(), 'pet-sheet-'));
  for (const [f, b] of files) writeFileSync(join(dir, f), b);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.deepEqual(validateDir(dir).errors, []);
  const again = sheetToAvatar(decodePng(encodePng([img])), { cell: { w: 20, h: 24 }, map: parseMap('IDLE=0:1,THINKING=1,ERROR=2:2'), id: 'grid', name: 'Grid', license: 'MIT' });
  assert.ok(Buffer.from(readFileSync(join(dir, 'thinking.png'))).equals(again.files.get('thinking.png')!), 'deterministic bytes');
});

test('sheet: anchors and hitbox follow the drawing, fitted bottom-aligned in the 160 box', () => {
  const { manifest } = sheetToAvatar(sheet(), { cell: { w: 20, h: 24 }, map: { IDLE: { row: 0, frames: 1 } }, id: 'g', name: 'G' });
  // Cell 20×24 → ×6.67 → 133×160, x offset 13. Square x 4..15, y 6..19 → 40..120, 40..133.
  assert.deepEqual(manifest.hitbox, { cx: 80, cy: 87, rx: 40, ry: 47 });
  assert.deepEqual(manifest.anchors, { feet: [80, 133], why: [66, 36] });
});

test('sheet: refuses what it cannot read, and says what to do', () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), /not a PNG/);
  const palette = encodePng([sheet()]);
  palette[8 + 8 + 9] = 3; // IHDR color type → palette (the CRC is not checked: the type is)
  assert.throws(() => decodePng(palette), /convert first/);
  assert.throws(() => parseMap('IDLE=zero'), /STATE=row/);
  assert.throws(() => sheetToAvatar(sheet(), { cell: { w: 20, h: 24 }, map: { THINKING: { row: 0 } }, id: 'x', name: 'X' }), /IDLE/);
  assert.equal(opaqueBox({ width: 2, height: 2, rgba: new Uint8Array(16) }), null);
});
