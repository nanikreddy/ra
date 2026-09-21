#!/usr/bin/env node
/**
 * WeddingCast server — zero-dependency Node.js (>= 18).
 *
 * Receives self-contained media segments uploaded by the broadcaster app
 * (store-and-forward: the camera records locally, then uploads each segment
 * reliably), stores them on disk, and serves a live playlist + segment files
 * to viewers. Fuzzy internet on the camera side only delays the stream; it
 * never reduces quality, because segments are recorded at full HD/4K before
 * they ever touch the network.
 *
 * Run:  node server.js
 * Env:  PORT, HOST, DATA_DIR, SITE_TITLE, BROADCAST_KEY, VIEWER_KEY,
 *       MAX_SEGMENT_MB, TLS_CERT, TLS_KEY (see README.md)
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const cfg = {
  port: Number(process.env.PORT || 8000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')),
  siteTitle: process.env.SITE_TITLE || 'Our Wedding',
  broadcastKey: process.env.BROADCAST_KEY || null,
  viewerKey: process.env.VIEWER_KEY || null,
  maxSegmentBytes: Number(process.env.MAX_SEGMENT_MB || 200) * 1024 * 1024,
  liveTimeoutMs: 20_000,
  viewerTtlMs: 12_000,
  autoEndAfterMs: 30 * 60_000,
  tlsCert: process.env.TLS_CERT || null,
  tlsKey: process.env.TLS_KEY || null,
  quiet: process.env.QUIET === '1',
};

const SESSIONS_DIR = () => path.join(cfg.dataDir, 'sessions');
const sessionDir = (id) => path.join(SESSIONS_DIR(), id);
const segmentsDir = (id) => path.join(sessionDir(id), 'segments');
const segFile = (id, seq) => path.join(segmentsDir(id), `${String(seq).padStart(8, '0')}.seg`);

/** In-memory session index; persisted to <dataDir>/sessions/<id>/session.json */
const sessions = new Map();

const log = (...a) => { if (!cfg.quiet) console.log(new Date().toISOString(), ...a); };

/* ---------------------------------------------------------------- helpers */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keysMatch = (given, expected) =>
  Boolean(given && expected) && crypto.timingSafeEqual(sha256(given), sha256(expected));

function bearerOf(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
const isBroadcaster = (req) =>
  keysMatch(req.headers['x-broadcast-key'] || bearerOf(req), cfg.broadcastKey);
const isViewer = (req, url) =>
  !cfg.viewerKey ||
  keysMatch(req.headers['x-viewer-key'] || url.searchParams.get('k'), cfg.viewerKey) ||
  isBroadcaster(req);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
const sendErr = (res, code, error) => sendJson(res, code, { error });

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const newSessionId = () => crypto.randomBytes(9).toString('base64url'); // 72 bits, URL-safe

/* ------------------------------------------------------------ persistence */

function sessionToDisk(s) {
  const segments = {};
  for (const [seq, m] of s.segments) segments[seq] = m;
  return {
    id: s.id, title: s.title, mime: s.mime, createdAt: s.createdAt,
    endedAt: s.endedAt, width: s.width, height: s.height, fps: s.fps,
    segmentMs: s.segmentMs, segments,
  };
}

const saveTimers = new Map();
function scheduleSave(s, delay = 1500) {
  if (saveTimers.has(s.id)) return;
  saveTimers.set(s.id, setTimeout(() => { saveTimers.delete(s.id); saveSession(s).catch((e) => log('save failed', s.id, e.message)); }, delay));
}
async function saveSession(s) {
  const file = path.join(sessionDir(s.id), 'session.json');
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(sessionToDisk(s)));
  await fsp.rename(tmp, file);
}
export function flushAllSync() {
  for (const s of sessions.values()) {
    try { fs.writeFileSync(path.join(sessionDir(s.id), 'session.json'), JSON.stringify(sessionToDisk(s))); }
    catch { /* best effort on shutdown */ }
  }
}

function makeSession(meta) {
  return {
    id: meta.id,
    title: meta.title || 'Wedding stream',
    mime: meta.mime || 'video/webm',
    createdAt: meta.createdAt || Date.now(),
    endedAt: meta.endedAt ?? null,
    width: meta.width || 0,
    height: meta.height || 0,
    fps: meta.fps || 0,
    segmentMs: meta.segmentMs || 4000,
    segments: new Map(),          // seq -> { d: durationMs, s: bytes, t: receivedAt }
    lastSeen: 0,                  // last heartbeat from broadcaster
    lastSegmentAt: 0,
    broadcaster: { state: 'unknown', backlogMs: 0, pendingSegments: 0 },
    viewers: new Map(),           // viewer id -> last poll ts
  };
}

async function scanDataDir() {
  sessions.clear();
  await fsp.mkdir(SESSIONS_DIR(), { recursive: true });
  const entries = await fsp.readdir(SESSIONS_DIR(), { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const id = ent.name;
    let meta = { id };
    try { meta = { ...JSON.parse(await fsp.readFile(path.join(sessionDir(id), 'session.json'), 'utf8')), id }; }
    catch { /* rebuild from files below */ }
    const s = makeSession(meta);
    let files = [];
    try { files = await fsp.readdir(segmentsDir(id)); } catch { /* no segments yet */ }
    for (const f of files) {
      const m = /^(\d{8})\.seg$/.exec(f);
      if (!m) continue;
      const seq = Number(m[1]);
      let size = 0;
      try { size = (await fsp.stat(path.join(segmentsDir(id), f))).size; } catch { continue; }
      const known = meta.segments?.[seq];
      s.segments.set(seq, { d: known?.d || s.segmentMs, s: size, t: known?.t || 0 });
    }
    if (s.segments.size || meta.title) sessions.set(id, s);
  }
  log(`loaded ${sessions.size} session(s) from ${cfg.dataDir}`);
}

/* ------------------------------------------------------------- session ops */

const now = () => Date.now();

function isLive(s) {
  if (s.endedAt) return false;
  const lastActivity = Math.max(s.lastSeen, s.lastSegmentAt);
  return lastActivity > 0 && now() - lastActivity < cfg.liveTimeoutMs;
}

function viewerCount(s) {
  const cutoff = now() - cfg.viewerTtlMs;
  for (const [vid, ts] of s.viewers) if (ts < cutoff) s.viewers.delete(vid);
  return s.viewers.size;
}

function totals(s) {
  let ms = 0, bytes = 0;
  for (const m of s.segments.values()) { ms += m.d; bytes += m.s; }
  return { ms, bytes };
}

function latestSeq(s) {
  let max = -1;
  for (const seq of s.segments.keys()) if (seq > max) max = seq;
  return max;
}

function summary(s) {
  const t = totals(s);
  return {
    id: s.id, title: s.title, mime: s.mime, createdAt: s.createdAt, endedAt: s.endedAt,
    live: isLive(s), width: s.width, height: s.height, fps: s.fps, segmentMs: s.segmentMs,
    latestSeq: latestSeq(s), segmentCount: s.segments.size,
    totalMs: t.ms, totalBytes: t.bytes, viewers: viewerCount(s),
    broadcaster: {
      state: s.broadcaster.state,
      backlogMs: s.broadcaster.backlogMs,
      pendingSegments: s.broadcaster.pendingSegments,
      lastSeenAgoMs: s.lastSeen ? now() - s.lastSeen : null,
    },
  };
}

function segmentList(s, since = -1) {
  return [...s.segments.entries()]
    .filter(([seq]) => seq > since)
    .sort((a, b) => a[0] - b[0])
    .map(([seq, m]) => ({ seq, d: m.d, s: m.s }));
}

/* every minute: expire viewers, auto-end long-quiet sessions */
setInterval(() => {
  for (const s of sessions.values()) {
    viewerCount(s);
    const lastActivity = Math.max(s.lastSeen, s.lastSegmentAt, s.createdAt);
    if (!s.endedAt && lastActivity && now() - lastActivity > cfg.autoEndAfterMs) {
      s.endedAt = lastActivity;
      s.broadcaster.state = 'stopped';
      scheduleSave(s);
      log(`auto-ended quiet session ${s.id}`);
    }
  }
}, 60_000).unref();

/* ------------------------------------------------------------ API handlers */

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/site') {
    return sendJson(res, 200, {
      siteTitle: cfg.siteTitle,
      viewerKeyRequired: Boolean(cfg.viewerKey),
      serverNow: now(),
    });
  }

  if (p === '/api/sessions' && req.method === 'POST') {
    if (!isBroadcaster(req)) return sendErr(res, 401, 'broadcast key required');
    let body;
    try { body = await readJsonBody(req); } catch (e) { return sendErr(res, 400, e.message); }
    // The client may supply its own id so it can start recording fully
    // offline and bind later; creation is idempotent for upload retries.
    let id = newSessionId();
    if (body.id !== undefined) {
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id)) {
        return sendErr(res, 400, 'invalid session id');
      }
      id = body.id;
      const existing = sessions.get(id);
      if (existing) return sendJson(res, 200, { session: summary(existing) });
    }
    const s = makeSession({
      id,
      title: String(body.title || 'Wedding stream').slice(0, 120),
      mime: String(body.mime || 'video/webm').slice(0, 200),
      width: Number(body.width) || 0,
      height: Number(body.height) || 0,
      fps: Number(body.fps) || 0,
      segmentMs: Math.min(Math.max(Number(body.segmentMs) || 4000, 1000), 60_000),
    });
    s.lastSeen = now();
    sessions.set(s.id, s);
    await fsp.mkdir(segmentsDir(s.id), { recursive: true });
    await saveSession(s);
    log(`session created ${s.id} "${s.title}" ${s.mime} ${s.width}x${s.height}`);
    return sendJson(res, 201, { session: summary(s) });
  }

  if (p === '/api/sessions' && req.method === 'GET') {
    if (!isViewer(req, url)) return sendErr(res, 401, 'viewer key required');
    const list = [...sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summary);
    return sendJson(res, 200, { siteTitle: cfg.siteTitle, sessions: list });
  }

  const m = /^\/api\/sessions\/([A-Za-z0-9_-]{1,64})(\/.*)?$/.exec(p);
  if (m) {
    const s = sessions.get(m[1]);
    const sub = m[2] || '';
    if (!s) return sendErr(res, 404, 'session not found');

    if (sub === '' && req.method === 'GET') {
      if (!isViewer(req, url)) return sendErr(res, 401, 'viewer key required');
      return sendJson(res, 200, { session: summary(s), segments: segmentList(s) });
    }

    if (sub === '/playlist' && req.method === 'GET') {
      if (!isViewer(req, url)) return sendErr(res, 401, 'viewer key required');
      const since = Number.isFinite(Number(url.searchParams.get('since')))
        ? Number(url.searchParams.get('since')) : -1;
      const vid = url.searchParams.get('vid');
      if (vid && vid.length <= 64 && (s.viewers.size < 5000 || s.viewers.has(vid))) {
        s.viewers.set(vid, now());
      }
      return sendJson(res, 200, {
        session: summary(s),
        serverNow: now(),
        segments: segmentList(s, since),
      });
    }

    const segM = /^\/segments\/(\d{1,8})$/.exec(sub);
    if (segM && req.method === 'POST') return handleSegmentUpload(req, res, s, Number(segM[1]));

    if (sub === '/heartbeat' && req.method === 'POST') {
      if (!isBroadcaster(req)) return sendErr(res, 401, 'broadcast key required');
      let body;
      try { body = await readJsonBody(req); } catch (e) { return sendErr(res, 400, e.message); }
      s.lastSeen = now();
      const state = ['recording', 'paused', 'stopped', 'draining'].includes(body.state) ? body.state : 'unknown';
      s.broadcaster = {
        state,
        backlogMs: Math.max(0, Number(body.backlogMs) || 0),
        pendingSegments: Math.max(0, Number(body.pendingSegments) || 0),
      };
      if (body.width) s.width = Number(body.width) || s.width;
      if (body.height) s.height = Number(body.height) || s.height;
      if (body.fps) s.fps = Number(body.fps) || s.fps;
      if (state === 'recording' && s.endedAt) {
        log(`session ${s.id} resumed after end`);
        s.endedAt = null;
      }
      scheduleSave(s);
      return sendJson(res, 200, { viewers: viewerCount(s), live: isLive(s), latestSeq: latestSeq(s) });
    }

    if (sub === '/end' && req.method === 'POST') {
      if (!isBroadcaster(req)) return sendErr(res, 401, 'broadcast key required');
      if (!s.endedAt) s.endedAt = now();
      s.broadcaster.state = 'stopped';
      scheduleSave(s);
      log(`session ended ${s.id}`);
      return sendJson(res, 200, { session: summary(s) });
    }

    return sendErr(res, 404, 'not found');
  }

  return sendErr(res, 404, 'not found');
}

function handleSegmentUpload(req, res, s, seq) {
  if (!isBroadcaster(req)) {
    sendErr(res, 401, 'broadcast key required');
    req.destroy();
    return;
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > cfg.maxSegmentBytes) {
    sendErr(res, 413, 'segment too large');
    req.destroy();
    return;
  }
  const dir = segmentsDir(s.id);
  const finalPath = segFile(s.id, seq);
  const tmpPath = path.join(dir, `.tmp-${seq}-${crypto.randomBytes(4).toString('hex')}`);
  let bytes = 0;
  let failed = false;

  fs.mkdirSync(dir, { recursive: true });
  const out = fs.createWriteStream(tmpPath);

  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fsp.unlink(tmpPath).catch(() => {});
    if (!res.headersSent) sendErr(res, code, msg);
    req.destroy();
  };

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > cfg.maxSegmentBytes) fail(413, 'segment too large');
  });
  req.on('aborted', () => fail(400, 'upload aborted'));
  req.on('error', () => fail(400, 'upload error'));
  out.on('error', (e) => fail(500, `write failed: ${e.code || e.message}`));

  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    if (bytes === 0) return fail(400, 'empty segment');
    fsp.rename(tmpPath, finalPath).then(() => {
      const d = Math.min(Math.max(Number(req.headers['x-duration-ms']) || s.segmentMs, 1), 120_000);
      s.segments.set(seq, { d, s: bytes, t: now() });
      s.lastSegmentAt = now();
      if (req.headers['x-width']) s.width = Number(req.headers['x-width']) || s.width;
      if (req.headers['x-height']) s.height = Number(req.headers['x-height']) || s.height;
      scheduleSave(s);
      sendJson(res, 200, { ok: true, seq, bytes, latestSeq: latestSeq(s) });
    }).catch((e) => fail(500, `store failed: ${e.code || e.message}`));
  });
}

/* ------------------------------------------------------------- media serve */

async function handleMedia(req, res, url) {
  const m = /^\/media\/([A-Za-z0-9_-]{1,64})\/(\d{1,8})$/.exec(url.pathname);
  if (!m) return sendErr(res, 404, 'not found');
  if (!isViewer(req, url)) return sendErr(res, 401, 'viewer key required');
  const s = sessions.get(m[1]);
  if (!s || !s.segments.has(Number(m[2]))) return sendErr(res, 404, 'segment not found');

  const file = segFile(s.id, Number(m[2]));
  let stat;
  try { stat = await fsp.stat(file); } catch { return sendErr(res, 404, 'segment not found'); }

  const headers = {
    'Content-Type': s.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
  };

  // Range support: the native <video> fallback player seeks inside segments.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = stat.size - 1, code = 200;
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') {           // suffix: last N bytes
      start = Math.max(0, stat.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), stat.size - 1);
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    code = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

/* ------------------------------------------------------------ static files */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return sendErr(res, 404, 'not found'); }
  if (rel === '/' || rel === '/index.html') rel = '/index.html';
  else if (rel === '/broadcast' || rel === '/broadcast/') rel = '/broadcast.html';
  else if (/^\/watch(\/|$)/.test(rel)) rel = '/watch.html';

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return sendErr(res, 404, 'not found');
  }
  let data;
  try { data = await fsp.readFile(file); } catch { return sendErr(res, 404, 'not found'); }

  const ext = path.extname(file).toLowerCase();
  const etag = `"${crypto.createHash('sha1').update(data).digest('base64url')}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    ETag: etag,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ------------------------------------------------------------------ server */

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/media/')) return await handleMedia(req, res, url);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url);
    return sendErr(res, 405, 'method not allowed');
  } catch (e) {
    log('request error', req.method, url.pathname, e.stack || e.message);
    if (!res.headersSent) sendErr(res, 500, 'internal error');
    else res.end();
  }
}

async function ensureBroadcastKey() {
  if (cfg.broadcastKey) return;
  const cfgFile = path.join(cfg.dataDir, 'config.json');
  try {
    const saved = JSON.parse(await fsp.readFile(cfgFile, 'utf8'));
    if (saved.broadcastKey) { cfg.broadcastKey = saved.broadcastKey; return; }
  } catch { /* first run */ }
  cfg.broadcastKey = crypto.randomBytes(5).toString('hex'); // 10 chars, easy to type
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await fsp.writeFile(cfgFile, JSON.stringify({ broadcastKey: cfg.broadcastKey }, null, 2));
}

function localAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

export async function startServer(overrides = {}) {
  Object.assign(cfg, overrides);
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  await ensureBroadcastKey();
  await scanDataDir();

  let server;
  let scheme = 'http';
  if (cfg.tlsCert && cfg.tlsKey) {
    server = https.createServer(
      { cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) },
      handle,
    );
    scheme = 'https';
  } else {
    server = http.createServer(handle);
  }
  server.requestTimeout = 0;      // large segment uploads on slow links may be long
  server.headersTimeout = 60_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  const port = server.address().port;

  log(`WeddingCast serving "${cfg.siteTitle}"`);
  log(`  local:     ${scheme}://localhost:${port}/`);
  for (const a of localAddresses()) log(`  network:   ${scheme}://${a}:${port}/`);
  log(`  broadcast: ${scheme}://localhost:${port}/broadcast   (broadcast key: ${cfg.broadcastKey})`);
  if (cfg.viewerKey) log('  viewer key required for watching');
  if (scheme === 'http') {
    log('  NOTE: phones need HTTPS to open the camera — see README "HTTPS for phones"');
  }
  return { server, port, cfg };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startServer().catch((e) => { console.error(e); process.exit(1); });
  const bye = () => { flushAllSync(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
