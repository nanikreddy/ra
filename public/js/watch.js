/* Viewer page: playlist polling, live status, DVR seek bar, overlays. */
'use strict';

(() => {
  const sessionId = decodeURIComponent(location.pathname.split('/')[2] || '');
  const vid = uuid(); // anonymous viewer id for the "N watching" counter

  const ui = {
    video: $('#video'), videoB: $('#videoB'), playerBox: $('#playerBox'),
    tapStart: $('#tapStart'), btnTap: $('#btnTap'), spinner: $('#spinner'),
    waitCard: $('#waitCard'), waitTitle: $('#waitTitle'), waitMsg: $('#waitMsg'),
    catchup: $('#catchup'),
    btnPlay: $('#btnPlay'), btnMute: $('#btnMute'), timeLabel: $('#timeLabel'),
    seekBar: $('#seekBar'), btnLive: $('#btnLive'), btnFull: $('#btnFull'),
    liveChip: $('#liveChip'), streamTitle: $('#streamTitle'),
    metaRes: $('#metaRes'), metaViewers: $('#metaViewers'), metaStatus: $('#metaStatus'),
  };

  const state = {
    session: null,
    ctrl: null,
    started: false,
    pollTimer: null,
    dragging: false,
    fatal: false,
  };
  window.__wcWatch = state; // e2e hook

  const show = (el, on = true) => { el.hidden = !on; };

  /* ------------------------------------------------------------- fetching */

  async function fetchSessionOnce() {
    for (;;) {
      try {
        return await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
      } catch (e) {
        if (e.status === 401) {
          const k = prompt('This stream is private. Enter the viewing code from your invitation:');
          if (k === null) { showFatal('A viewing code is required to watch this stream.'); return null; }
          store.set('viewerKey', k.trim());
        } else if (e.status === 404) {
          showFatal('This stream does not exist (check the link).');
          return null;
        } else {
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    }
  }

  async function poll() {
    try {
      const since = state.ctrl ? state.ctrl.latestSeq() : -1;
      const data = await api(
        `/api/sessions/${encodeURIComponent(sessionId)}/playlist?since=${since}&vid=${vid}`,
        { timeoutMs: 8000 },
      );
      state.session = data.session;
      if (state.ctrl) state.ctrl.addSegments(data.segments);
      maybeStart();
      paintMeta();
      if (data.session.endedAt && state.ctrl) {
        state.ctrl.markEnded();
        stopPolling();
        paintMeta();
      }
    } catch { /* transient viewer-side blip; next tick retries */ }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(poll, 2000);
  }
  function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }

  /* -------------------------------------------------------------- startup */

  async function maybeStart() {
    if (state.started || state.fatal || !state.ctrl) return;
    if (!state.ctrl.orderedSeqs.length) {
      show(ui.waitCard, true);
      ui.waitTitle.textContent = state.session?.live
        ? 'Waiting for the first pictures…'
        : 'Stream has not started yet';
      return;
    }
    state.started = true;
    show(ui.waitCard, false);
    const ok = await state.ctrl.start({ live: Boolean(state.session?.live && !state.session?.endedAt) });
    if (!ok) return;
    attachVideoEvents();
    tryAutoplay();
  }

  function tryAutoplay() {
    state.ctrl.setMuted(true);
    show(ui.tapStart, true);
    ui.btnTap.querySelector('span').textContent = 'Tap to start';
    const onPlaying = () => { // muted autoplay worked: the tap is only for sound
      ui.btnTap.querySelector('span').textContent = 'Tap to watch with sound';
    };
    ui.video.addEventListener('playing', onPlaying, { once: true });
    ui.videoB.addEventListener('playing', onPlaying, { once: true });
    state.ctrl.play().catch(() => { /* needs the tap */ });
  }

  function attachVideoEvents() {
    for (const v of [ui.video, ui.videoB]) {
      v.addEventListener('waiting', () => { if (!state.ctrl.paused) show(ui.spinner, true); });
      v.addEventListener('playing', () => { show(ui.spinner, false); updatePlayBtn(); paintRes(); });
      v.addEventListener('pause', updatePlayBtn);
      v.addEventListener('play', updatePlayBtn);
    }
  }

  function showFatal(msg) {
    state.fatal = true;
    show(ui.waitCard, true);
    ui.waitTitle.textContent = 'Cannot play this stream';
    ui.waitMsg.textContent = msg;
    show(ui.spinner, false);
  }

  /* ------------------------------------------------------------------ UI */

  function updatePlayBtn() {
    ui.btnPlay.textContent = state.ctrl && !state.ctrl.paused ? '⏸' : '▶';
  }

  function paintRes() {
    const v = state.ctrl?.activeVideo();
    if (v && v.videoWidth) {
      ui.metaRes.textContent = fmt.res(v.videoWidth, v.videoHeight) || `${v.videoWidth}×${v.videoHeight}`;
      show(ui.metaRes, true);
    }
  }

  function paintMeta() {
    const s = state.session;
    if (!s) return;
    ui.streamTitle.textContent = s.title;
    document.title = `${s.title} · Watch`;

    if (s.endedAt) {
      ui.liveChip.className = 'chip chip-idle';
      ui.liveChip.textContent = 'Recording';
      ui.metaStatus.textContent = `Streamed ${fmt.clock(s.createdAt)} · ${fmt.dur(s.totalMs)}`;
    } else if (s.live) {
      ui.liveChip.className = 'chip chip-live';
      ui.liveChip.textContent = '● LIVE';
      ui.metaStatus.textContent = '';
    } else {
      ui.liveChip.className = 'chip chip-warn';
      ui.liveChip.textContent = 'Signal lost';
      ui.metaStatus.textContent = 'The camera lost its connection — the stream resumes automatically.';
    }
    ui.metaViewers.textContent = s.endedAt ? '' : `${s.viewers} watching · `;

    // Transparency about the store-and-forward delay: if the camera's uplink
    // is fuzzy, tell viewers their pictures are late, not lost.
    const backlog = s.broadcaster?.backlogMs || 0;
    if (!s.endedAt && backlog > 10_000) {
      ui.catchup.textContent = `Weak signal at the venue — the picture is ${fmt.secs(backlog)} behind and catching up in full quality.`;
      show(ui.catchup, true);
    } else {
      show(ui.catchup, false);
    }
  }

  function paintTimeline() {
    const c = state.ctrl;
    if (!c || !state.started) return;
    const total = c.durationMs();
    const cur = Math.min(c.globalTimeMs(), total);
    if (!state.dragging && total > 0) {
      ui.seekBar.value = String(Math.round((cur / total) * 1000));
    }
    const isLiveNow = state.session?.live && !state.session?.endedAt;
    const atEdge = isLiveNow && c.behindLiveMs() < 8000;
    ui.btnLive.classList.toggle('at-edge', Boolean(atEdge));
    ui.btnLive.hidden = !isLiveNow;
    ui.timeLabel.textContent = atEdge
      ? 'LIVE'
      : `${fmt.dur(cur)}${total ? ` / ${fmt.dur(total)}` : ''}`;
    c.maintainLive();
  }

  /* ------------------------------------------------------------ controls */

  function bindControls() {
    ui.btnTap.addEventListener('click', () => {
      show(ui.tapStart, false);
      state.ctrl.unlock();          // gesture-bless both video elements (iOS)
      state.ctrl.setMuted(false);
      ui.btnMute.textContent = '🔊';
      state.ctrl.play().catch(() => {});
    });
    ui.btnPlay.addEventListener('click', () => {
      if (state.ctrl.paused) state.ctrl.play().catch(() => {});
      else { state.ctrl.followLive = false; state.ctrl.pause(); }
    });
    ui.btnMute.addEventListener('click', () => {
      const nowMuted = !(state.ctrl.engineKind === 'seq' ? state.ctrl.engine.muted : ui.video.muted);
      state.ctrl.setMuted(nowMuted);
      ui.btnMute.textContent = nowMuted ? '🔇' : '🔊';
    });
    ui.btnLive.addEventListener('click', () => state.ctrl.goLive());
    ui.btnFull.addEventListener('click', () => {
      const box = ui.playerBox;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
      else state.ctrl.activeVideo().webkitEnterFullscreen?.(); // iPhone
    });
    ui.seekBar.addEventListener('input', () => { state.dragging = true; });
    ui.seekBar.addEventListener('change', () => {
      state.dragging = false;
      const t = (Number(ui.seekBar.value) / 1000) * state.ctrl.durationMs();
      state.ctrl.seekGlobalMs(t);
      state.ctrl.play().catch(() => {});
    });
  }

  /* ---------------------------------------------------------------- init */

  async function init() {
    if (!sessionId) { showFatal('No stream id in the link.'); return; }
    try {
      const site = await api('/api/site');
      $('#siteTitle').textContent = site.siteTitle;
    } catch { /* fine */ }

    const data = await fetchSessionOnce();
    if (!data) return;
    state.session = data.session;

    state.ctrl = new PlayerController({
      video: ui.video, videoB: ui.videoB, sessionId,
      mime: data.session.mime,
      onStatus: (st) => {
        if (st.fatal) showFatal(st.fatal);
        if (st.engineSwitched) toast('Switched to compatibility playback');
      },
    });
    state.ctrl.addSegments(data.segments.map((x) => ({ seq: x.seq, d: x.d, s: x.s })));
    paintMeta();
    await maybeStart();

    if (data.session.endedAt) {
      state.ctrl.markEnded();
    } else {
      startPolling();
    }
    bindControls();
    setInterval(paintTimeline, 500);
    setInterval(paintRes, 3000);
  }

  init();
})();
