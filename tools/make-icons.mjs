#!/usr/bin/env node
/**
 * Generates the PWA icons (PNG) without any dependencies: shapes are drawn
 * with signed-distance functions and encoded as PNG via node:zlib.
 * Run `npm run icons` after changing colors/shapes; outputs are committed.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------- PNG bits */
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- drawing */
const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG_TOP = hex('#241f1a');
const BG_BOT = hex('#141210');
const GOLD = hex('#c9a55c');
const GOLD2 = hex('#e8cf9a');
const LIVE = hex('#d9534a');

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;
const sdRing = (px, py, cx, cy, r, halfW) => Math.abs(Math.hypot(px - cx, py - cy) - r) - halfW;
function sdRoundRect(px, py, cx, cy, hw, hh, rad) {
  const qx = Math.abs(px - cx) - (hw - rad);
  const qy = Math.abs(py - cy) - (hh - rad);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
}
const coverage = (d, feather) => Math.min(1, Math.max(0, 0.5 - d / feather));

function drawIcon(size, { maskable }) {
  const img = Buffer.alloc(size * size * 4);
  const f = 1.25; // feather px
  const s = maskable ? 0.76 : 1; // safe-zone scale for maskable
  const S = (v) => size * (0.5 + (v - 0.5) * s);
  const R = (v) => size * v * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      let r = 0, g = 0, b = 0, a = 0;

      // background: rounded square (full-bleed square when maskable)
      const bgD = maskable
        ? -1
        : sdRoundRect(px, py, size / 2, size / 2, size / 2, size / 2, size * 0.21);
      const bgA = coverage(bgD, f);
      if (bgA > 0) {
        const t = y / size;
        r = BG_TOP[0] * (1 - t) + BG_BOT[0] * t;
        g = BG_TOP[1] * (1 - t) + BG_BOT[1] * t;
        b = BG_TOP[2] * (1 - t) + BG_BOT[2] * t;
        a = bgA;
      }

      const put = (col, cov) => {
        if (cov <= 0) return;
        r = col[0] * cov + r * (1 - cov);
        g = col[1] * cov + g * (1 - cov);
        b = col[2] * cov + b * (1 - cov);
        a = Math.max(a, cov * (maskable ? 1 : bgA));
      };

      // two interlocking rings
      put(GOLD, coverage(sdRing(px, py, S(0.40), S(0.54), R(0.175), R(0.028)), f));
      put(GOLD2, coverage(sdRing(px, py, S(0.585), S(0.54), R(0.175), R(0.028)), f));
      // "live" dot
      put(LIVE, coverage(sdCircle(px, py, S(0.76), S(0.245), R(0.058)), f));

      const i = (y * size + x) * 4;
      img[i] = Math.round(r);
      img[i + 1] = Math.round(g);
      img[i + 2] = Math.round(b);
      img[i + 3] = Math.round(a * 255);
    }
  }
  return encodePNG(img, size, size);
}

writeFileSync(path.join(OUT, 'icon-512.png'), drawIcon(512, { maskable: false }));
writeFileSync(path.join(OUT, 'icon-192.png'), drawIcon(192, { maskable: false }));
writeFileSync(path.join(OUT, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));
writeFileSync(path.join(OUT, 'icon-180.png'), drawIcon(180, { maskable: true })); // apple-touch: opaque

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#241f1a"/><stop offset="1" stop-color="#141210"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="21" fill="url(#bg)"/>
  <circle cx="40" cy="54" r="17.5" fill="none" stroke="#c9a55c" stroke-width="5.6"/>
  <circle cx="58.5" cy="54" r="17.5" fill="none" stroke="#e8cf9a" stroke-width="5.6"/>
  <circle cx="76" cy="24.5" r="5.8" fill="#d9534a"/>
</svg>\n`;
writeFileSync(path.join(OUT, 'icon.svg'), svg);

console.log('icons written to', OUT);
