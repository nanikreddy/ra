/*
 * Broadcaster app: camera → SegmentRecorder → SegmentDB (on-device, full
 * quality) → Uploader (store-and-forward) → server.
 *
 * The recording pipeline is deliberately independent of the network: fuzzy
 * or absent internet grows the local backlog, never drops quality or frames.
 */
'use strict';

(() => {
  const qs = new URLSearchParams(location.search);
  const E2E = qs.has('e2e');

  const ui = {
    topStatus: $('#topStatus'), httpsWarn: $('#httpsWarn'),
    recover: $('#recover'), recoverList: $('#recoverList'),
    gate: $('#gate'), keyInput: $('#keyInput'), keySave: $('#keySave'), keyMsg: $('#keyMsg'),
    setup: $('#setup'), preview: $('#preview'), previewBadge: $('#previewBadge'),
    btnPreview: $('#btnPreview'), setupMsg: $('#setupMsg'),
    titleInput: $('#titleInput'), qualitySel: $('#qualitySel'), formatSel: $('#formatSel'),
    camSel: $('#camSel'), micSel: $('#micSel'), segSel: $('#segSel'),
    bitrateInput: $('#bitrateInput'), audioProcSel: $('#audioProcSel'),
    keepLocalSel: $('#keepLocalSel'), mimeNote: $('#mimeNote'), btnGoLive: $('#btnGoLive'),
    live: $('#live'), liveVideo: $('#liveVideo'), liveBadge: $('#liveBadge'), liveRes: $('#liveRes'),
    netBanner: $('#netBanner'),
    stElapsed: $('#stElapsed'), stBitrate: $('#stBitrate'), stBacklog: $('#stBacklog'),
    stUpRate: $('#stUpRate'), stViewers: $('#stViewers'), stStorage: $('#stStorage'),
    shareLink: $('#shareLink'), btnCopy: $('#btnCopy'), btnStop: $('#btnStop'),
    finish: $('#finish'), finishTitle: $('#finishTitle'), finishMsg: $('#finishMsg'),
    finishBar: $('#finishBar'), finishDone: $('#finishDone'), finishLink: $('#finishLink'),
    btnCopy2: $('#btnCopy2'), btnAgain: $('#btnAgain'),
  };

  const state = {
    site: { siteTitle: 'WeddingCast', viewerKeyRequired: false },
    key: broadcastKey(),
    stream: null,
    recorder: null,
    uploader: null,
    sessionId: null,
    sessionBound: false,
    phase: 'idle', // idle | preview | live | draining | done
    startedAt: 0,
    elapsedBaseMs: 0,
    encodeBps: 0,
    heartbeatTimer: null,
    uiTimer: null,
    wakeLock: null,
    trackW: 0, trackH: 0, trackFps: 0,
    binderTimer: null,
    lastError: null,
  };
  window.__wc = state; // e2e / debugging hook

  const show = (el, on = true) => { el.hidden = !on; };
  const panel = (name) => {
    for (const p of ['gate', 'setup', 'live', 'finish']) show(ui[p], p === name);
  };

  function settings() {
    const customMbps = Number(ui.bitrateInput.value) || 0;
    const preset = QUALITY_PRESETS[ui.qualitySel.value] || QUALITY_PRESETS['1080'];
    return {
      title: ui.titleInput.value.trim() || 'Wedding stream',
      preset: ui.qualitySel.value,
      format: ui.formatSel.value,
      videoDeviceId: ui.camSel.value || undefined,
      audioDeviceId: ui.micSel.value || undefined,
      segmentMs: Number(ui.segSel.value) || 4000,
      videoBps: customMbps > 0 ? Math.round(customMbps * 1e6) : preset.videoBps,
      audioProcessing: ui.audioProcSel.checked,
      keepLocal: ui.keepLocalSel.checked,
    };
  }

  function persistSettings() {
    const s = settings();
    store.set('bset', {
      preset: s.preset, format: s.format, segmentMs: s.segmentMs,
      audioProcessing: s.audioProcessing, keepLocal: s.keepLocal,
      customMbps: Number(ui.bitrateInput.value) || 0, title: s.title,
    });
  }
  function restoreSettings() {
    const s = store.get('bset');
    if (!s) return;
    if (s.preset) ui.qualitySel.value = s.preset;
    if (s.format) ui.formatSel.value = s.format;
    if (s.segmentMs) ui.segSel.value = String(s.segmentMs);
    ui.audioProcSel.checked = Boolean(s.audioProcessing);
    ui.keepLocalSel.checked = s.keepLocal !== false;
    if (s.customMbps) ui.bitrateInput.value = String(s.customMbps);
    if (s.title) ui.titleInput.value = s.title;
  }

  /* ------------------------------------------------------------ mime note */
  function updateMimeNote() {
    const mime = pickMime(ui.formatSel.value);
    if (mime === null) {
      ui.mimeNote.textContent = 'This browser cannot record video (no MediaRecorder). Try Chrome or Safari.';
      return;
    }
    if (!mime) {
      ui.mimeNote.textContent = 'Selected format is not supported by this browser — "Auto" will pick a working one.';
      return;
    }
    const isMp4 = mime.startsWith('video/mp4');
    ui.mimeNote.textContent = `Recording as ${mime}. ${isMp4
      ? 'Plays natively on every phone, including iPhones.'
      : 'Smooth playback on Chrome / Edge / Firefox / Android. iPhone viewers may not be able to play WebM — choose MP4 if many guests use iPhones.'}`;
  }

  /* -------------------------------------------------------------- camera */
  async function startPreview() {
    stopStream();
    show(ui.setupMsg, false);
    try {
      state.stream = await openCamera(settings());
    } catch (e) {
      ui.setupMsg.textContent = e.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow camera & microphone for this site and try again.'
        : `Could not open the camera: ${e.message || e.name}`;
      show(ui.setupMsg);
      return false;
    }
    ui.preview.srcObject = state.stream;
    const t = state.stream.getVideoTracks()[0];
    const st = t ? t.getSettings() : {};
    state.trackW = st.width || 0; state.trackH = st.height || 0; state.trackFps = Math.round(st.frameRate || 0);
    ui.previewBadge.textContent = `${st.width || '?'}×${st.height || '?'}${st.frameRate ? ` @ ${Math.round(st.frameRate)}` : ''}`;
    show(ui.previewBadge);
    const want = QUALITY_PRESETS[ui.qualitySel.value];
    if (want && st.width && Math.max(st.width, st.height) < want.width) {
      toast(`This camera provides ${st.width}×${st.height} (requested ${want.width}×${want.height}).`);
    }
    await refreshDevices();
    ui.btnGoLive.disabled = false;
    state.phase = 'preview';
    return true;
  }

  function stopStream() {
    if (state.stream) for (const t of state.stream.getTracks()) t.stop();
    state.stream = null;
  }

  async function refreshDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const fill = (sel, kind, defLabel) => {
        const cur = sel.value;
        sel.innerHTML = '';
        const d0 = document.createElement('option');
        d0.value = ''; d0.textContent = defLabel;
        sel.appendChild(d0);
        for (const d of devs.filter((x) => x.kind === kind)) {
          const o = document.createElement('option');
          o.value = d.deviceId;
          o.textContent = d.label || `${kind === 'videoinput' ? 'Camera' : 'Mic'} ${sel.length}`;
          sel.appendChild(o);
        }
        if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
      };
      fill(ui.camSel, 'videoinput', 'Default (rear)');
      fill(ui.micSel, 'audioinput', 'Default');
    } catch { /* not critical */ }
  }

  /* ------------------------------------------------- session bind (retry) */
  function bindSession(meta) {
    const attempt = async () => {
      if (state.sessionBound) return;
      try {
        await api('/api/sessions', { method: 'POST', key: state.key, body: meta });
        state.sessionBound = true;
        SegmentDB.putSession({ ...meta, bound: 1 }).catch(() => {});
        state.uploader?._kick(true);
      } catch (e) {
        if (e.status === 401) {
          setNetBanner('err', 'Broadcast key rejected by the server — check the key. Recording continues locally.');
          return; // do not retry a bad key in a loop
        }
        state.binderTimer = setTimeout(attempt, 5000);
      }
    };
    attempt();
  }

  /* ------------------------------------------------------------- go live */
  async function goLive(existing = null) {
    if (state.phase === 'live' || state.phase === 'draining') return;
    persistSettings();
    const s = settings();
    const mime = existing?.mime && MediaRecorder.isTypeSupported(existing.mime)
      ? existing.mime
      : pickMime(s.format);
    if (!mime && mime !== '') { toast('This browser cannot record video.'); return; }
    if (existing?.mime && mime !== existing.mime) {
      toast('This browser cannot record in the original stream format. Starting a new stream instead.');
      existing = null;
    }
    if (!state.stream && !(await startPreview())) return;

    state.sessionId = existing?.id || uuid().replace(/-/g, '').slice(0, 16);
    state.sessionBound = false;
    state.startedAt = Date.now();
    state.elapsedBaseMs = existing?.priorMs || 0;
    state.encodeBps = 0;
    state.lastError = null;

    state.uploader = new Uploader({
      sessionId: state.sessionId,
      key: state.key,
      keepLocal: s.keepLocal,
      onChange: () => scheduleStatPaint(),
    });
    state.uploader.start();

    // Re-enqueue anything already pending for this session (continue flow).
    try {
      for (const row of await SegmentDB.listSegments(state.sessionId)) {
        if (!row.uploaded) state.uploader.enqueue({ seq: row.seq, size: row.size, durationMs: row.durationMs });
      }
    } catch { /* fresh session */ }

    const startSeq = existing?.startSeq || 0;
    state.recorder = new SegmentRecorder(state.stream, {
      mimeType: mime,
      videoBitsPerSecond: s.videoBps,
      audioBitsPerSecond: 192_000,
      segmentMs: s.segmentMs,
      startSeq,
      onSegment: onSegment,
      onError: (err) => {
        state.lastError = err;
        toast(`Recorder error: ${err.message}`);
        if (state.phase === 'live') stopLive(false, 'Recorder failed — uploads continuing.');
      },
    });
    state.recorder.start();

    // Bind the server session AFTER the recorder starts, so the session
    // carries the codec string the browser actually chose. Retries forever
    // in the background if we are offline right now.
    const meta = {
      id: state.sessionId,
      title: existing?.title || s.title,
      mime: state.recorder.actualMime || mime || 'video/webm',
      width: state.trackW, height: state.trackH, fps: state.trackFps,
      segmentMs: s.segmentMs,
      createdAt: existing?.createdAt || Date.now(),
      keepLocal: s.keepLocal,
    };
    SegmentDB.putSession({ ...meta, bound: 0 }).catch(() => {});
    SegmentDB.persist();
    bindSession(meta);

    const vt = state.stream.getVideoTracks()[0];
    if (vt) vt.addEventListener('ended', () => {
      if (state.phase === 'live') stopLive(false, 'Camera disconnected — stream stopped. Uploading what was recorded.');
    });

    ui.liveVideo.srcObject = state.stream;
    ui.liveRes.textContent = `${state.trackW}×${state.trackH}${state.trackFps ? ` @ ${state.trackFps}` : ''}`;
    ui.shareLink.value = `${location.origin}/watch/${state.sessionId}`;
    if (state.site.viewerKeyRequired) {
      toast('Note: guests will be asked for the viewing code when they open the link.');
    }
    state.phase = 'live';
    panel('live');
    show(ui.recover, false);
    show(ui.topStatus); setTopStatus();
    acquireWakeLock();
    startHeartbeat();
    state.uiTimer = setInterval(paintStats, 1000);
    paintStats();
  }

  async function onSegment(blob, meta) {
    const rec = {
      sessionId: state.sessionId, seq: meta.seq, blob,
      mime: state.recorder.actualMime, durationMs: meta.durationMs,
      recordedAt: meta.recordedAt, size: blob.size, uploaded: 0,
      width: state.trackW, height: state.trackH,
    };
    const bps = (blob.size * 8) / (meta.durationMs / 1000);
    state.encodeBps = state.encodeBps ? state.encodeBps * 0.7 + bps * 0.3 : bps;
    try {
      await SegmentDB.putSegment(rec);
      state.uploader.enqueue({ seq: meta.seq, size: blob.size, durationMs: meta.durationMs });
    } catch (e) {
      // Storage failed (quota/private mode): upload straight from memory.
      state.uploader.enqueue({ seq: meta.seq, size: blob.size, durationMs: meta.durationMs, ram: rec });
      setNetBanner('warn', 'Device storage unavailable — streaming from memory only (do not close this page).');
    }
  }

  /* ------------------------------------------------------------ stopping */
  async function stopLive(ask = true, reason = null) {
    if (state.phase !== 'live') return;
    if (ask && !E2E && !confirm('Stop the broadcast?')) return;
    state.phase = 'draining';
    setTopStatus();
    panel('finish');
    ui.finishTitle.textContent = 'Finishing upload…';
    ui.finishMsg.textContent = reason || 'Sending the last segments to the server — keep this page open.';
    show(ui.finishDone, false);

    try { await state.recorder.stop(); } catch { /* recorded what we could */ }
    stopStream();

    const total = () => {
      const st = state.uploader.stats();
      return { done: st.uploadedBytes, left: st.pendingBytes };
    };
    const t0 = total();
    const denom = t0.done + t0.left || 1;
    let lastDone = t0.done;
    let lastChange = Date.now();
    const prog = setInterval(() => {
      const t = total();
      ui.finishBar.style.width = `${Math.min(100, Math.round((1 - t.left / denom) * 100))}%`;
      if (t.done !== lastDone) { lastDone = t.done; lastChange = Date.now(); }
      else if (t.left > 0 && Date.now() - lastChange > 15_000) {
        ui.finishMsg.textContent = 'No connection right now. Your footage is safe on this device — '
          + 'you can close this page and resume the upload later from the broadcast page.';
      }
    }, 300);

    await state.uploader.drain();
    clearInterval(prog);
    ui.finishBar.style.width = '100%';

    try { await api(`/api/sessions/${state.sessionId}/end`, { method: 'POST', key: state.key }); }
    catch { /* offline: session will auto-end; footage is safe locally */ }

    stopHeartbeat();
    releaseWakeLock();
    clearInterval(state.uiTimer);
    clearTimeout(state.binderTimer);
    state.phase = 'done';
    setTopStatus();

    const st = state.uploader.stats();
    ui.finishTitle.textContent = st.pendingSegments === 0 ? 'Stream ended' : 'Stopped — some segments still local';
    ui.finishMsg.textContent = st.pendingSegments === 0
      ? `Uploaded ${fmt.bytes(st.uploadedBytes)} in ${st.uploadedSegments} segments at full quality.`
      : 'Some segments could not reach the server. Reopen this page later to resume the upload — nothing is lost.';
    ui.finishLink.value = `${location.origin}/watch/${state.sessionId}`;
    show(ui.finishDone);
  }

  /* --------------------------------------------------------- resume flows */
  async function scanRecoverables() {
    let rows = [];
    try { rows = await SegmentDB.pendingSummary(); } catch { return; }
    const metas = new Map((await SegmentDB.allSessions().catch(() => [])).map((m) => [m.id, m]));
    const items = rows.filter((r) => r.pending > 0);
    if (!items.length) { show(ui.recover, false); return; }
    ui.recoverList.innerHTML = '';
    for (const r of items) {
      const meta = metas.get(r.sessionId) || { title: 'Recorded stream', id: r.sessionId };
      const card = document.createElement('div');
      card.className = 'recover-item';
      card.innerHTML = `
        <div class="recover-info">
          <strong></strong>
          <span class="muted"></span>
        </div>
        <div class="row">
          <button class="btn btn-gold" data-act="resume">Resume upload</button>
          <button class="btn btn-ghost" data-act="continue">Continue broadcasting</button>
          <button class="btn btn-ghost btn-danger" data-act="discard">Discard</button>
        </div>`;
      card.querySelector('strong').textContent = meta.title || 'Recorded stream';
      card.querySelector('span').textContent =
        `${r.pending} segments · ${fmt.bytes(r.pendingBytes)} · ${fmt.dur(r.pendingMs)} of footage waiting`;
      card.addEventListener('click', async (ev) => {
        const act = ev.target.dataset && ev.target.dataset.act;
        if (!act) return;
        if (act === 'discard') {
          if (!E2E && !confirm('Delete this locally stored footage? If it was never uploaded it cannot be recovered.')) return;
          await SegmentDB.deleteSession(r.sessionId).catch(() => {});
          scanRecoverables();
        } else if (act === 'resume') {
          resumeUpload(meta, r);
        } else if (act === 'continue') {
          continueSession(meta, r);
        }
      });
      ui.recoverList.appendChild(card);
    }
    show(ui.recover);
  }

  async function resumeUpload(meta, r) {
    if (!requireKey()) return;
    panel('finish');
    show(ui.recover, false);
    ui.finishTitle.textContent = 'Resuming upload…';
    ui.finishMsg.textContent = 'Sending locally stored segments to the server — keep this page open.';
    show(ui.finishDone, false);
    state.sessionId = meta.id;
    state.sessionBound = false;
    bindSession({ ...meta, id: meta.id });
    state.uploader = new Uploader({
      sessionId: meta.id, key: state.key,
      keepLocal: meta.keepLocal !== false,
      onChange: () => {},
    });
    state.uploader.start();
    const rows = await SegmentDB.listSegments(meta.id);
    let totalBytes = 0;
    for (const row of rows) {
      if (row.uploaded) continue;
      totalBytes += row.size;
      state.uploader.enqueue({ seq: row.seq, size: row.size, durationMs: row.durationMs });
    }
    const prog = setInterval(() => {
      const st = state.uploader.stats();
      ui.finishBar.style.width = `${Math.min(100, Math.round((1 - st.pendingBytes / (totalBytes || 1)) * 100))}%`;
    }, 300);
    startHeartbeat('draining');
    await state.uploader.drain();
    clearInterval(prog);
    stopHeartbeat();
    ui.finishBar.style.width = '100%';
    try { await api(`/api/sessions/${meta.id}/end`, { method: 'POST', key: state.key }); } catch { /* offline */ }
    ui.finishTitle.textContent = 'Upload complete';
    ui.finishMsg.textContent = 'All locally stored footage is now on the server at full quality.';
    ui.finishLink.value = `${location.origin}/watch/${meta.id}`;
    show(ui.finishDone);
  }

  async function continueSession(meta, r) {
    if (!requireKey()) return;
    let serverLatest = -1;
    try {
      const info = await api(`/api/sessions/${meta.id}`, { key: state.key });
      serverLatest = info.session.latestSeq;
      meta.priorMs = info.session.totalMs;
    } catch { /* offline: rely on local max */ }
    const startSeq = Math.max(serverLatest, r.maxSeq) + 1;
    panel('setup');
    show(ui.recover, false);
    if (!(await startPreview())) return;
    await goLive({ ...meta, startSeq });
  }

  /* ------------------------------------------------------- heartbeat / ui */
  function startHeartbeat(forcedState = null) {
    stopHeartbeat();
    const beat = async () => {
      const st = state.uploader ? state.uploader.stats() : { pendingMs: 0, pendingSegments: 0 };
      try {
        const r = await api(`/api/sessions/${state.sessionId}/heartbeat`, {
          method: 'POST', key: state.key, timeoutMs: 5000,
          body: {
            state: forcedState || (state.phase === 'live' ? 'recording' : state.phase === 'draining' ? 'draining' : 'stopped'),
            backlogMs: st.pendingMs,
            pendingSegments: st.pendingSegments,
            width: state.trackW, height: state.trackH, fps: state.trackFps,
          },
        });
        ui.stViewers.textContent = String(r.viewers ?? 0);
      } catch { /* offline is fine */ }
    };
    beat();
    state.heartbeatTimer = setInterval(beat, 3000);
  }
  function stopHeartbeat() { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }

  let statPaintQueued = false;
  function scheduleStatPaint() {
    if (statPaintQueued) return;
    statPaintQueued = true;
    requestAnimationFrame(() => { statPaintQueued = false; paintStats(); });
  }

  function setNetBanner(kind, text) {
    ui.netBanner.className = `net-banner net-${kind}`;
    ui.netBanner.textContent = text;
  }

  function setTopStatus() {
    const map = {
      live: ['chip-live', '● LIVE'],
      draining: ['chip-warn', 'Uploading…'],
      done: ['chip-idle', 'Ended'],
    };
    const [cls, txt] = map[state.phase] || ['chip-idle', 'Idle'];
    ui.topStatus.className = `chip ${cls}`;
    ui.topStatus.textContent = txt;
  }

  async function paintStats() {
    if (!state.uploader) return;
    const st = state.uploader.stats();
    ui.stElapsed.textContent = fmt.dur(state.elapsedBaseMs + (Date.now() - state.startedAt));
    ui.stBitrate.textContent = state.encodeBps ? fmt.mbps(state.encodeBps) : '—';
    ui.stBacklog.textContent = st.pendingSegments === 0 ? '0s' : `${fmt.secs(st.pendingMs)} (${fmt.bytes(st.pendingBytes)})`;
    ui.stUpRate.textContent = st.rateBps ? `${fmt.bytes(st.rateBps)}/s` : '—';

    if (!navigator.onLine || (st.stalled && st.pendingSegments > 0)) {
      setNetBanner('err', `No connection — recording continues at full quality. ${fmt.secs(st.pendingMs)} of footage stored locally, will upload automatically.`);
    } else if (st.pendingMs > (Number(ui.segSel.value) || 4000) * 2.5) {
      setNetBanner('warn', `Connection is slower than the video — viewers are ${fmt.secs(st.pendingMs)} behind. Nothing is lost.`);
    } else if (!state.sessionBound) {
      setNetBanner('warn', 'Waiting for the server — recording locally in the meantime.');
    } else {
      setNetBanner('ok', 'Connected — stream is up to date');
    }

    if (!paintStats._n) paintStats._n = 0;
    if (paintStats._n++ % 10 === 0) {
      const u = await SegmentDB.usage();
      ui.stStorage.textContent = u.quota ? `${fmt.bytes(u.used)} / ${fmt.bytes(u.quota)}` : '—';
      if (u.quota && u.quota - u.used < 500 * 1024 * 1024 && st.pendingSegments > 0) {
        toast('Device storage is running low — connect to a better network soon.');
      }
    }
  }

  /* ------------------------------------------------------------ wake lock */
  async function acquireWakeLock() {
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* unsupported */ }
  }
  function releaseWakeLock() {
    try { state.wakeLock?.release(); } catch { /* ignore */ }
    state.wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (state.phase === 'live' || state.phase === 'draining')) acquireWakeLock();
  });

  /* ----------------------------------------------------------------- gate */
  function requireKey() {
    if (state.key) return true;
    panel('gate');
    return false;
  }

  /* ----------------------------------------------------------------- init */
  async function init() {
    try {
      state.site = await api('/api/site');
      $('#siteTitle').textContent = state.site.siteTitle;
      document.title = `Broadcast · ${state.site.siteTitle}`;
    } catch { /* offline start: fine */ }

    if (!window.isSecureContext) show(ui.httpsWarn);
    if (!navigator.mediaDevices?.getUserMedia) {
      show(ui.httpsWarn);
      ui.httpsWarn.querySelector('h2').textContent = 'Camera unavailable';
    }

    restoreSettings();
    updateMimeNote();
    scanRecoverables();
    panel(state.key ? 'setup' : 'gate');

    ui.keySave.addEventListener('click', async () => {
      const k = ui.keyInput.value.trim();
      if (!k) return;
      show(ui.keyMsg, false);
      try {
        // Validate the key against the server when reachable: an invalid id
        // returns 400 once the key is accepted, 401 when it is not.
        await api('/api/sessions', { method: 'POST', key: k, body: { id: '!' } });
      } catch (e) {
        if (e.status === 401) {
          ui.keyMsg.textContent = 'That key was rejected by the server.';
          show(ui.keyMsg);
          return;
        }
        // 400 (invalid probe id) or network error both mean the key was not rejected.
      }
      state.key = k;
      store.set('broadcastKey', k);
      panel('setup');
    });
    ui.keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ui.keySave.click(); });

    ui.btnPreview.addEventListener('click', startPreview);
    ui.formatSel.addEventListener('change', updateMimeNote);
    for (const sel of [ui.camSel, ui.micSel, ui.qualitySel]) {
      sel.addEventListener('change', () => { if (state.stream) startPreview(); });
    }
    ui.btnGoLive.addEventListener('click', () => goLive());
    ui.btnStop.addEventListener('click', () => stopLive(true));
    ui.btnAgain.addEventListener('click', () => { location.href = '/broadcast'; });

    const copy = (input) => () => {
      input.select();
      navigator.clipboard?.writeText(input.value).then(() => toast('Link copied'))
        .catch(() => document.execCommand('copy'));
    };
    ui.btnCopy.addEventListener('click', copy(ui.shareLink));
    ui.btnCopy2.addEventListener('click', copy(ui.finishLink));

    window.addEventListener('beforeunload', (e) => {
      if (E2E) return;
      const pending = state.uploader ? state.uploader.stats().pendingSegments : 0;
      if (state.phase === 'live' || state.phase === 'draining' || pending > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    state.goLive = goLive;       // e2e hooks
    state.stopLive = stopLive;
    state.startPreview = startPreview;
  }

  init();
})();
