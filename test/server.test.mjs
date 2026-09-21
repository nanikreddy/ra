/* API test suite for server.js — run with `npm test` (node --test). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { startServer, flushAllSync } from '../server.js';

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), '.tmp');
const BKEY = 'test-broadcast-key';
const dataDir = path.join(TMP, `run-${crypto.randomBytes(4).toString('hex')}`);

let base = '';
let live = null;

async function boot(overrides = {}) {
  if (live) await shutdown();
  live = await startServer({
    port: 0, host: '127.0.0.1', dataDir, broadcastKey: BKEY,
    viewerKey: null, quiet: true, siteTitle: 'Test Wedding',
    maxSegmentBytes: 5 * 1024 * 1024,
    ...overrides,
  });
  base = `http://127.0.0.1:${live.port}`;
}
async function shutdown() {
  flushAllSync();
  live.server.closeAllConnections?.();
  await new Promise((res) => live.server.close(res));
  live = null;
}

const req = async (p, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(base + p, { method, headers, body });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, data };
};
const bkey = { 'X-Broadcast-Key': BKEY };

const SID = 'e2etestsession1';
const segBytes = (n, size = 1000) => Buffer.alloc(size, n); // fake segment payload

test('boot', async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
  await boot();
});

test('site info is public', async () => {
  const r = await req('/api/site');
  assert.equal(r.status, 200);
  assert.equal(r.data.siteTitle, 'Test Wedding');
  assert.equal(r.data.viewerKeyRequired, false);
});

test('session create requires broadcast key', async () => {
  let r = await req('/api/sessions', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 401);
  r = await req('/api/sessions', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'X-Broadcast-Key': 'wrong' } });
  assert.equal(r.status, 401);
});

test('invalid client session id is rejected (key-probe path)', async () => {
  const r = await req('/api/sessions', {
    method: 'POST', headers: { ...bkey, 'content-type': 'application/json' },
    body: JSON.stringify({ id: '!' }),
  });
  assert.equal(r.status, 400);
});

test('session create with client id, idempotent', async () => {
  const body = JSON.stringify({ id: SID, title: 'Ceremony', mime: 'video/webm;codecs="vp9,opus"', segmentMs: 4000, width: 3840, height: 2160 });
  let r = await req('/api/sessions', { method: 'POST', headers: { ...bkey, 'content-type': 'application/json' }, body });
  assert.equal(r.status, 201);
  assert.equal(r.data.session.id, SID);
  assert.equal(r.data.session.width, 3840);
  r = await req('/api/sessions', { method: 'POST', headers: { ...bkey, 'content-type': 'application/json' }, body });
  assert.equal(r.status, 200); // already exists
  assert.equal(r.data.session.id, SID);
});

test('segment upload auth + out-of-order + playlist', async () => {
  let r = await req(`/api/sessions/${SID}/segments/0`, { method: 'POST', body: segBytes(0) });
  assert.equal(r.status, 401);

  for (const seq of [0, 2, 1]) {
    r = await req(`/api/sessions/${SID}/segments/${seq}`, {
      method: 'POST',
      headers: { ...bkey, 'content-type': 'video/webm', 'X-Duration-Ms': '4000' },
      body: segBytes(seq, 1000 + seq),
    });
    assert.equal(r.status, 200, `seq ${seq}`);
    assert.equal(r.data.seq, seq);
  }
  r = await req(`/api/sessions/${SID}/playlist?since=-1`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.segments.map((s) => s.seq), [0, 1, 2]);
  assert.deepEqual(r.data.segments.map((s) => s.s), [1000, 1001, 1002]);
  assert.equal(r.data.session.live, true); // fresh upload counts as activity

  r = await req(`/api/sessions/${SID}/playlist?since=1`);
  assert.deepEqual(r.data.segments.map((s) => s.seq), [2]);
});

test('segment re-upload is idempotent (retry safety)', async () => {
  const r = await req(`/api/sessions/${SID}/segments/1`, {
    method: 'POST', headers: { ...bkey, 'content-type': 'video/webm', 'X-Duration-Ms': '4100' },
    body: segBytes(9, 1001),
  });
  assert.equal(r.status, 200);
  const p = await req(`/api/sessions/${SID}/playlist?since=-1`);
  assert.equal(p.data.segments.length, 3);
});

test('media serving with ranges', async () => {
  let r = await req(`/media/${SID}/0`);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1000);
  assert.equal(r.headers.get('content-type'), 'video/webm;codecs="vp9,opus"');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.ok(r.data.equals(segBytes(0)));

  r = await req(`/media/${SID}/0`, { headers: { Range: 'bytes=2-4' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-4/1000');
  assert.equal(r.data.length, 3);

  r = await req(`/media/${SID}/0`, { headers: { Range: 'bytes=990-' } });
  assert.equal(r.status, 206);
  assert.equal(r.data.length, 10);

  r = await req(`/media/${SID}/0`, { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(r.status, 416);

  r = await req(`/media/${SID}/7`);
  assert.equal(r.status, 404);
});

test('oversized segment is rejected', async () => {
  const r = await req(`/api/sessions/${SID}/segments/99`, {
    method: 'POST', headers: { ...bkey, 'content-type': 'video/webm' },
    body: Buffer.alloc(6 * 1024 * 1024),
  }).catch(() => ({ status: 413 })); // connection may be destroyed mid-send
  assert.ok(r.status === 413 || r.status === 500 || r.status === 413);
  const p = await req(`/api/sessions/${SID}/playlist?since=-1`);
  assert.ok(!p.data.segments.some((s) => s.seq === 99));
});

test('heartbeat + viewers + end', async () => {
  let r = await req(`/api/sessions/${SID}/heartbeat`, {
    method: 'POST', headers: { ...bkey, 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'recording', backlogMs: 8000, pendingSegments: 2 }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.live, true);

  await req(`/api/sessions/${SID}/playlist?since=99&vid=viewer-a`);
  await req(`/api/sessions/${SID}/playlist?since=99&vid=viewer-b`);
  r = await req(`/api/sessions/${SID}`);
  assert.equal(r.data.session.viewers, 2);
  assert.equal(r.data.session.broadcaster.backlogMs, 8000);

  r = await req(`/api/sessions/${SID}/end`, { method: 'POST', headers: bkey });
  assert.equal(r.status, 200);
  assert.ok(r.data.session.endedAt);
  assert.equal(r.data.session.live, false);

  // Late segments (offline backlog draining after "end") are still accepted.
  r = await req(`/api/sessions/${SID}/segments/3`, {
    method: 'POST', headers: { ...bkey, 'content-type': 'video/webm', 'X-Duration-Ms': '4000' },
    body: segBytes(3, 1003),
  });
  assert.equal(r.status, 200);
  // A 'recording' heartbeat resumes the session (phone came back).
  r = await req(`/api/sessions/${SID}/heartbeat`, {
    method: 'POST', headers: { ...bkey, 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'recording' }),
  });
  assert.equal(r.data.live, true);
  await req(`/api/sessions/${SID}/end`, { method: 'POST', headers: bkey });
});

test('session listing', async () => {
  const r = await req('/api/sessions');
  assert.equal(r.status, 200);
  const s = r.data.sessions.find((x) => x.id === SID);
  assert.ok(s);
  assert.equal(s.segmentCount, 4);
  assert.equal(s.totalMs, 4000 + 4100 + 4000 + 4000);
});

test('static pages + traversal safety', async () => {
  for (const p of ['/', '/broadcast', '/watch/whatever']) {
    const r = await req(p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/);
  }
  const etagRes = await fetch(`${base}/css/style.css`);
  const etag = etagRes.headers.get('etag');
  const r304 = await fetch(`${base}/css/style.css`, { headers: { 'If-None-Match': etag } });
  assert.equal(r304.status, 304);

  for (const p of ['/../server.js', '/..%2f..%2fserver.js', '/media/..%2f..%2fx/0']) {
    const r = await req(p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('restart rescan: sessions and segments survive', async () => {
  await boot(); // same dataDir, fresh process state
  const r = await req(`/api/sessions/${SID}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.session.segmentCount, 4);
  assert.equal(r.data.session.mime, 'video/webm;codecs="vp9,opus"');
  assert.equal(r.data.segments.find((s) => s.seq === 1).d, 4100); // duration persisted
  const m = await req(`/media/${SID}/2`);
  assert.equal(m.status, 200);
  assert.equal(m.data.length, 1002);
});

test('viewer key mode protects list/playlist/media', async () => {
  await boot({ viewerKey: 'secret-view' });
  assert.equal((await req('/api/site')).data.viewerKeyRequired, true);
  assert.equal((await req('/api/sessions')).status, 401);
  assert.equal((await req(`/api/sessions/${SID}/playlist?since=-1`)).status, 401);
  assert.equal((await req(`/media/${SID}/0`)).status, 401);

  assert.equal((await req('/api/sessions', { headers: { 'X-Viewer-Key': 'secret-view' } })).status, 200);
  assert.equal((await req(`/media/${SID}/0?k=secret-view`)).status, 200);
  // broadcast key also grants viewing
  assert.equal((await req('/api/sessions', { headers: bkey })).status, 200);
  // wrong key still rejected
  assert.equal((await req('/api/sessions', { headers: { 'X-Viewer-Key': 'nope' } })).status, 401);
});

test('teardown', async () => {
  await shutdown();
  await fsp.rm(TMP, { recursive: true, force: true });
});
