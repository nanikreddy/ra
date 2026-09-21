#!/usr/bin/env node
/**
 * Stitch a recorded session's segments into one continuous keepsake file —
 * losslessly (no re-encode) via ffmpeg's concat demuxer.
 *
 * Usage:
 *   node tools/stitch.mjs <sessionId> [outFile] [--data <dataDir>]
 *   node tools/stitch.mjs --list            # show recorded sessions
 *
 * Without ffmpeg installed it still writes the concat list and prints the
 * exact command to run elsewhere.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const dataDir = dataIdx >= 0 ? path.resolve(args.splice(dataIdx, 2)[1]) : path.join(ROOT, 'data');
const sessionsDir = path.join(dataDir, 'sessions');

function die(msg) { console.error(msg); process.exit(1); }

if (!fs.existsSync(sessionsDir)) die(`No recordings found (${sessionsDir} does not exist).`);

if (args[0] === '--list' || args.length === 0) {
  console.log('Recorded sessions:\n');
  for (const id of fs.readdirSync(sessionsDir)) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, id, 'session.json'), 'utf8'));
      const n = Object.keys(meta.segments || {}).length;
      const ms = Object.values(meta.segments || {}).reduce((a, s) => a + (s.d || 0), 0);
      console.log(`  ${id}  "${meta.title}"  ${n} segments  ${Math.round(ms / 60000)} min  ${meta.mime}`);
    } catch { /* skip */ }
  }
  console.log('\nStitch one with: node tools/stitch.mjs <sessionId>');
  process.exit(0);
}

const id = args[0];
const dir = path.join(sessionsDir, id);
if (!fs.existsSync(dir)) die(`Session ${id} not found in ${sessionsDir}`);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
const segDir = path.join(dir, 'segments');
const files = fs.readdirSync(segDir).filter((f) => /^\d{8}\.seg$/.test(f)).sort();
if (!files.length) die('Session has no segments.');

const isMp4 = (meta.mime || '').startsWith('video/mp4');
const out = args[1] || path.join(dir, `${(meta.title || id).replace(/[^\w-]+/g, '_')}.${isMp4 ? 'mp4' : 'webm'}`);
const listFile = path.join(dir, 'concat.txt');
fs.writeFileSync(listFile, files.map((f) => `file '${path.join(segDir, f).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
console.log(`Wrote ${listFile} (${files.length} segments, ${meta.mime})`);

const cmd = ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', ...(isMp4 ? ['-movflags', '+faststart'] : []), '-y', out];
const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
if (probe.error) {
  console.log('\nffmpeg is not installed here. Run this where it is:\n');
  console.log(`  ffmpeg ${cmd.map((a) => (/[ ']/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
  process.exit(0);
}
console.log('Running ffmpeg (lossless copy, no re-encode)…');
const r = spawnSync('ffmpeg', cmd, { stdio: 'inherit' });
if (r.status !== 0) die('\nffmpeg failed — the command above can be re-run manually.');
console.log(`\nDone: ${out}`);
