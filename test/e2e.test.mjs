/*
 * End-to-end test: real Chromium with a fake camera.
 *
 *  1. Broadcaster page goes live → segments are recorded, stored on-device,
 *     uploaded to the server.
 *  2. Viewer page plays the stream (MSE or the sequential fallback) and time
 *     advances.
 *  3. THE POINT OF THIS PROJECT: the broadcaster goes fully offline
 *     mid-stream. Recording must continue, the local backlog must grow, and
 *     when the network returns every missing segment must reach the server
 *     at full quality (no holes in the sequence).
 *  4. Stop → session ends, all segments drained.
 *
 * Requires the `playwright` package (any recent version) and its Chromium.
 * Run: npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); // global install fallback
  } catch {
    console.log('SKIP: playwright not installed (npm i -D playwright)');
    process.exit(0);
  }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'test', '.tmp', `e2e-${crypto.randomBytes(4).toString('hex')}`);
const BKEY = 'e2e-broadcast-key';
const PORT = 8790 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const SEG_MS = 2000;

const log = (...a) => console.log('  •', ...a);
function assert(cond, msg) {
  if (!cond) { console.error(`✗ ASSERT FAILED: ${msg}`); process.exitCode = 1; throw new Error(msg); }
  log(`✓ ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, desc, timeoutMs = 30_000, everyMs = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(everyMs);
  }
}

const api = async (p, opts = {}) => {
  const res = await fetch(BASE + p, opts);
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

let serverProc, browser;

async function main() {
  await fsp.mkdir(TMP, { recursive: true });

  /* ---- server ---- */
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TMP, BROADCAST_KEY: BKEY, QUIET: '1' },
    stdio: 'inherit',
  });
  await waitFor(async () => (await api('/api/site').catch(() => null))?.status === 200, 'server up', 15000);
  log('server running');

  /* ---- browser ---- */
  browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  /* ---- broadcaster goes live ---- */
  const bctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bpage = await bctx.newPage();
  bpage.on('pageerror', (e) => console.error('  broadcaster pageerror:', e.message));
  await bpage.addInitScript(([k]) => {
    localStorage.setItem('wc.broadcastKey', JSON.stringify(k));
  }, [BKEY]);
  await bpage.goto(`${BASE}/broadcast?e2e=1&nosw=1`);
  await bpage.waitForFunction(() => window.__wc);
  await bpage.evaluate(() => { document.querySelector('.advanced').open = true; });
  await bpage.selectOption('#segSel', String(SEG_MS));
  await bpage.selectOption('#qualitySel', '720');
  await bpage.fill('#titleInput', 'E2E Ceremony');
  await bpage.click('#btnGoLive');
  await bpage.waitForFunction(() => window.__wc.phase === 'live', null, { timeout: 20000 });
  const sessionId = await bpage.evaluate(() => window.__wc.sessionId);
  const mime = await bpage.evaluate(() => window.__wc.recorder.actualMime);
  log(`live: session=${sessionId} mime=${mime}`);

  await waitFor(async () => {
    const st = await bpage.evaluate(() => window.__wc.uploader.stats());
    return st.uploadedSegments >= 3;
  }, '3 segments uploaded', 30000);

  let pl = await api(`/api/sessions/${sessionId}/playlist?since=-1`);
  assert(pl.status === 200, 'playlist reachable');
  assert(pl.data.segments.length >= 3, `server holds ${pl.data.segments.length} segments`);
  assert(pl.data.session.live === true, 'session is live');
  assert(pl.data.session.mime === mime, 'session mime matches recorder');
  const sizes = pl.data.segments.map((s) => s.s);
  assert(sizes.every((n) => n > 5000), `segments have real video data (sizes ${sizes.slice(0, 3).join(',')}…)`);

  /* ---- viewer plays ---- */
  const vctx = await browser.newContext();
  const vpage = await vctx.newPage();
  vpage.on('pageerror', (e) => console.error('  viewer pageerror:', e.message));
  await vpage.goto(`${BASE}/watch/${sessionId}?nosw=1`);
  await vpage.waitForFunction(() => window.__wcWatch && window.__wcWatch.started, null, { timeout: 20000 });
  await waitFor(async () => vpage.evaluate(() => {
    const c = window.__wcWatch.ctrl;
    const v = c && c.activeVideo();
    return v && v.currentTime > 1.5 && v.videoWidth > 0;
  }), 'viewer video is playing and advancing', 30000);
  const engine = await vpage.evaluate(() => window.__wcWatch.ctrl.engineKind);
  const dims = await vpage.evaluate(() => {
    const v = window.__wcWatch.ctrl.activeVideo();
    return `${v.videoWidth}x${v.videoHeight}`;
  });
  log(`viewer engine=${engine} resolution=${dims}`);
  assert(['mse', 'seq'].includes(engine), `playback engine active (${engine})`);

  /* ---- THE fuzzy-internet scenario ---- */
  log('cutting broadcaster network…');
  const seqBeforeOffline = (await api(`/api/sessions/${sessionId}/playlist?since=-1`)).data.session.latestSeq;
  await bctx.setOffline(true);
  await sleep(SEG_MS * 4); // record ~4 segments with no network

  const duringOffline = await bpage.evaluate(() => ({
    phase: window.__wc.phase,
    recState: window.__wc.recorder.state,
    stats: window.__wc.uploader.stats(),
  }));
  assert(duringOffline.phase === 'live' && duringOffline.recState === 'recording',
    'recording continues while offline');
  assert(duringOffline.stats.pendingSegments >= 2,
    `backlog grew while offline (${duringOffline.stats.pendingSegments} segments, ${duringOffline.stats.pendingMs}ms waiting)`);
  const backlogged = duringOffline.stats.pendingSegments;

  log('restoring broadcaster network…');
  await bctx.setOffline(false);
  await waitFor(async () => {
    const st = await bpage.evaluate(() => window.__wc.uploader.stats());
    return st.pendingSegments === 0;
  }, 'backlog fully drained after reconnect', 45000);

  pl = await api(`/api/sessions/${sessionId}/playlist?since=-1`);
  const seqs = pl.data.segments.map((s) => s.seq);
  const contiguous = seqs.every((s, i) => s === i);
  assert(contiguous, `no holes in the stream after outage (seqs 0..${seqs[seqs.length - 1]})`);
  assert(pl.data.session.latestSeq > seqBeforeOffline + backlogged - 1,
    'offline-recorded segments reached the server at full quality');

  /* ---- viewer catches up across the outage ---- */
  await waitFor(async () => vpage.evaluate(() => {
    const c = window.__wcWatch.ctrl;
    return c.latestSeq() >= 6;
  }), 'viewer learned about post-outage segments', 20000);
  const t1 = await vpage.evaluate(() => window.__wcWatch.ctrl.activeVideo().currentTime);
  await sleep(3000);
  const t2 = await vpage.evaluate(() => window.__wcWatch.ctrl.activeVideo().currentTime);
  assert(t2 > t1, `viewer still advancing after outage (${t1.toFixed(1)}s → ${t2.toFixed(1)}s)`);

  /* ---- stop and finalize ---- */
  await bpage.evaluate(() => window.__wc.stopLive(false));
  await bpage.waitForFunction(() => window.__wc.phase === 'done', null, { timeout: 30000 });
  const fin = await api(`/api/sessions/${sessionId}`);
  assert(Boolean(fin.data.session.endedAt), 'session marked ended');
  assert(fin.data.session.segmentCount === fin.data.segments.length, 'all segments accounted for');
  log(`final: ${fin.data.session.segmentCount} segments, ${(fin.data.session.totalBytes / 1e6).toFixed(1)} MB, ${(fin.data.session.totalMs / 1000).toFixed(0)}s`);

  /* ---- VOD: a fresh viewer can replay the ended stream ---- */
  const v2 = await (await browser.newContext()).newPage();
  await v2.goto(`${BASE}/watch/${sessionId}?nosw=1`);
  await v2.waitForFunction(() => window.__wcWatch && window.__wcWatch.started, null, { timeout: 20000 });
  await waitFor(async () => v2.evaluate(() => {
    const v = window.__wcWatch.ctrl.activeVideo();
    return v && v.currentTime > 1;
  }), 'VOD works', 25000);
  assert(true, 'VOD replay works after the stream ended');

  /* ================= scenario 2: crash while offline, then recover ===== */
  log('scenario 2: page crash during an outage, footage recovered later');
  const b2 = await bctx.newPage();
  await b2.evaluate(() => { /* placeholder for symmetry */ });
  await b2.goto(`${BASE}/broadcast?e2e=1&nosw=1`);
  await b2.waitForFunction(() => window.__wc);
  await b2.evaluate(() => { document.querySelector('.advanced').open = true; });
  await b2.selectOption('#segSel', String(SEG_MS));
  await b2.selectOption('#qualitySel', '720');
  await b2.fill('#titleInput', 'E2E Crash Recovery');
  await b2.click('#btnGoLive');
  await b2.waitForFunction(() => window.__wc.phase === 'live', null, { timeout: 20000 });
  const sid2 = await b2.evaluate(() => window.__wc.sessionId);
  await waitFor(async () => (await api(`/api/sessions/${sid2}/playlist?since=-1`)).data.segments?.length >= 1,
    'second session streaming', 20000);

  await bctx.setOffline(true);
  await sleep(SEG_MS * 3); // build an un-uploaded backlog
  const pendingBefore = await b2.evaluate(() => window.__wc.uploader.stats().pendingSegments);
  assert(pendingBefore >= 2, `backlog exists before crash (${pendingBefore} segments)`);
  await b2.close(); // "the phone browser died"
  await bctx.setOffline(false);

  const b3 = await bctx.newPage(); // same device (same browser storage)
  await b3.goto(`${BASE}/broadcast?e2e=1&nosw=1`);
  await b3.waitForFunction(() => window.__wc);
  await waitFor(() => b3.evaluate(() => !document.querySelector('#recover').hidden), 'recovery card shown', 15000);
  const recovText = await b3.evaluate(() => document.querySelector('#recoverList').textContent);
  assert(recovText.includes('E2E Crash Recovery'), 'recovery card names the interrupted stream');
  await b3.click('#recoverList [data-act="resume"]');
  await waitFor(async () => {
    const p = await api(`/api/sessions/${sid2}/playlist?since=-1`);
    const seqs = (p.data.segments || []).map((s) => s.seq);
    return seqs.length >= pendingBefore && seqs.every((s, i) => s === i) && p.data.session.endedAt;
  }, 'crashed footage fully recovered to server, session closed', 40000);
  assert(true, 'crash-recovery upload drained with no holes');

  /* ---- landing page lists both streams ---- */
  const home = await vctx.newPage();
  await home.goto(`${BASE}/?nosw=1`);
  await waitFor(() => home.evaluate(() => document.querySelectorAll('.session-card').length >= 2),
    'landing page lists sessions', 15000);
  assert(true, 'landing page lists both streams');

  /* ============ scenario 3: WebM/VP9 stream exercises the MSE engine ==== */
  log('scenario 3: VP9 broadcast → seamless MSE playback');
  const b4 = await bctx.newPage();
  await b4.goto(`${BASE}/broadcast?e2e=1&nosw=1`);
  await b4.waitForFunction(() => window.__wc);
  await b4.evaluate(() => { document.querySelector('.advanced').open = true; });
  await b4.selectOption('#segSel', String(SEG_MS));
  await b4.selectOption('#qualitySel', '720');
  await b4.selectOption('#formatSel', 'vp9');
  await b4.fill('#titleInput', 'E2E VP9');
  await b4.click('#btnGoLive');
  await b4.waitForFunction(() => window.__wc.phase === 'live', null, { timeout: 20000 });
  const sid3 = await b4.evaluate(() => window.__wc.sessionId);
  const mime3 = await b4.evaluate(() => window.__wc.recorder.actualMime);
  assert(mime3.includes('webm'), `VP9 broadcast uses webm (${mime3})`);
  await waitFor(async () => {
    const st = await b4.evaluate(() => window.__wc.uploader.stats());
    return st.uploadedSegments >= 3;
  }, 'vp9 segments uploaded', 30000);

  const v3 = await vctx.newPage();
  await v3.goto(`${BASE}/watch/${sid3}?nosw=1`);
  await v3.waitForFunction(() => window.__wcWatch && window.__wcWatch.started, null, { timeout: 20000 });
  await waitFor(async () => v3.evaluate(() => {
    const c = window.__wcWatch.ctrl;
    const v = c && c.activeVideo();
    return v && v.currentTime > 2 && v.videoWidth > 0;
  }), 'MSE viewer playing and advancing', 30000);
  const engine3 = await v3.evaluate(() => window.__wcWatch.ctrl.engineKind);
  assert(engine3 === 'mse', `webm stream plays through the seamless MSE engine (${engine3})`);

  // DVR: seek back to the beginning while live, then return to the edge.
  await v3.evaluate(() => window.__wcWatch.ctrl.seekGlobalMs(0));
  await sleep(1500);
  const dvrT = await v3.evaluate(() => window.__wcWatch.ctrl.globalTimeMs());
  assert(dvrT < 6000, `DVR seek back while live works (position ${(dvrT / 1000).toFixed(1)}s)`);
  await v3.evaluate(() => window.__wcWatch.ctrl.goLive());
  await waitFor(async () => v3.evaluate(() => window.__wcWatch.ctrl.behindLiveMs() < 10_000),
    'returned to the live edge', 15000);
  assert(true, 'go-live returns to the edge after DVR');

  await b4.evaluate(() => window.__wc.stopLive(false));
  await b4.waitForFunction(() => window.__wc.phase === 'done', null, { timeout: 30000 });

  console.log('\nALL E2E CHECKS PASSED');
}

main()
  .catch((e) => { console.error('\nE2E FAILED:', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    try { serverProc?.kill('SIGTERM'); } catch { /* ignore */ }
    await sleep(300);
    await fsp.rm(TMP, { recursive: true, force: true }).catch(() => {});
    process.exit(process.exitCode || 0);
  });
