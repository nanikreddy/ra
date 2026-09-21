/*
 * Viewer playback engines.
 *
 * The stream is a growing list of short SELF-CONTAINED segments uploaded at
 * original HD/4K quality. Playback strategies, best first:
 *
 *  1. MsePlayer — MediaSource (or ManagedMediaSource on iOS 17.1+) in
 *     'sequence' mode: segments are appended back-to-back for seamless,
 *     buffered playback with DVR.
 *  2. SeqPlayer — two alternating <video> elements playing segment files
 *     natively (preloading the next while one plays). Works anywhere the
 *     codec plays at all — including iPhones for MP4 streams — with a
 *     barely visible seam at segment boundaries.
 *
 * The PlayerController owns the playlist, live-edge following, hole
 * handling (a segment delayed by the broadcaster's fuzzy uplink), DVR
 * seeking and automatic MSE→Seq fallback.
 */
'use strict';

const MS = window.ManagedMediaSource || window.MediaSource || null;

function mimePlayableNatively(video, mime) {
  try { return video.canPlayType(mime) || video.canPlayType(mime.split(';')[0]); }
  catch { return ''; }
}
function mimeMseSupported(mime) {
  try { return Boolean(MS && MS.isTypeSupported(mime)); } catch { return false; }
}

/* ------------------------------------------------------------------ MSE */

class MsePlayer {
  constructor(video, mime, onFatal) {
    this.video = video;
    this.mime = mime;
    this.onFatal = onFatal;
    this.ms = null;
    this.sb = null;
    this.queue = [];
    this.appending = false;
    this.appendedMs = 0;     // total media time appended (from segment metadata)
    this.baseOffsetMs = 0;   // global ms at engine timeline zero
    this.dead = false;
    this.ended = false;
  }

  async setup(baseOffsetMs) {
    this.baseOffsetMs = baseOffsetMs;
    this.ms = new MS();
    if ('disableRemotePlayback' in this.video && window.ManagedMediaSource) {
      this.video.disableRemotePlayback = true;
    }
    const opened = new Promise((res) => this.ms.addEventListener('sourceopen', res, { once: true }));
    this.video.src = URL.createObjectURL(this.ms);
    await opened;
    try {
      this.sb = this.ms.addSourceBuffer(this.mime);
    } catch (e) {
      return this._fatal(e);
    }
    try { this.sb.mode = 'sequence'; } catch { /* some UAs are strict; timestamps then rule */ }
    this.sb.addEventListener('updateend', () => { this.appending = false; this._pump(); });
    this.sb.addEventListener('error', () => this._fatal(new Error('SourceBuffer error')));
    this.video.addEventListener('error', () => {
      if (!this.dead && this.video.error) this._fatal(this.video.error);
    });
    return true;
  }

  append(buf, durationMs) {
    if (this.dead) return;
    this.queue.push({ buf, durationMs });
    this._pump();
  }

  _pump() {
    if (this.dead || this.appending || !this.sb || this.sb.updating || !this.queue.length) return;
    this._trim();
    const item = this.queue[0];
    try {
      this.appending = true;
      this.sb.appendBuffer(item.buf);
      this.queue.shift();
      this.appendedMs += item.durationMs;
    } catch (e) {
      this.appending = false;
      if (e.name === 'QuotaExceededError') {
        this._evict().then(() => this._pump());
      } else {
        this._fatal(e);
      }
    }
  }

  _trim() {
    // Keep memory bounded for hours-long 4K streams.
    try {
      const b = this.video.buffered;
      const ct = this.video.currentTime;
      if (b.length && !this.sb.updating && ct - b.start(0) > 150) {
        this.sb.remove(b.start(0), ct - 90);
      }
    } catch { /* not critical */ }
  }

  async _evict() {
    try {
      const b = this.video.buffered;
      const ct = this.video.currentTime;
      if (b.length && ct - b.start(0) > 20) {
        await new Promise((res) => {
          this.sb.addEventListener('updateend', res, { once: true });
          this.sb.remove(b.start(0), Math.max(b.start(0) + 1, ct - 15));
        });
      }
    } catch { /* fall through to fatal on next append */ }
  }

  bufferedEndMs() {
    try {
      const b = this.video.buffered;
      return b.length ? b.end(b.length - 1) * 1000 : 0;
    } catch { return 0; }
  }
  bufferedAheadMs() { return Math.max(0, this.bufferedEndMs() - this.video.currentTime * 1000); }
  globalTimeMs() { return this.baseOffsetMs + this.video.currentTime * 1000; }

  seekWithinMs(globalMs) {
    const local = (globalMs - this.baseOffsetMs) / 1000;
    try {
      const b = this.video.buffered;
      for (let i = 0; i < b.length; i++) {
        if (local >= b.start(i) - 0.3 && local <= b.end(i)) {
          this.video.currentTime = Math.max(b.start(i), Math.min(local, b.end(i) - 0.05));
          return true;
        }
      }
    } catch { /* fallthrough */ }
    return false;
  }

  jumpToEnd() {
    try {
      const b = this.video.buffered;
      if (b.length) this.video.currentTime = Math.max(b.start(b.length - 1), b.end(b.length - 1) - 1);
    } catch { /* ignore */ }
  }

  finalize() {
    this.ended = true;
    const tryEOS = () => {
      if (this.dead) return;
      if (this.queue.length || this.appending || (this.sb && this.sb.updating)) {
        setTimeout(tryEOS, 250);
      } else {
        try { if (this.ms.readyState === 'open') this.ms.endOfStream(); } catch { /* ignore */ }
      }
    };
    tryEOS();
  }

  _fatal(err) {
    if (this.dead) return false;
    this.dead = true;
    this.onFatal(err);
    return false;
  }

  destroy() {
    this.dead = true;
    this.queue = [];
    try { if (this.ms && this.ms.readyState === 'open') this.ms.endOfStream(); } catch { /* ignore */ }
    try { this.video.removeAttribute('src'); this.video.load(); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------- dual-<video> fallback */

class SeqPlayer {
  /** @param {HTMLVideoElement} a @param {HTMLVideoElement} b */
  constructor(a, b, urlFor) {
    this.els = [a, b];
    this.active = 0;
    this.urlFor = urlFor;
    this.playing = [-1, -1];  // which segment index is loaded in each element
    this.index = -1;          // currently playing position in this.order
    this.order = [];          // seqs in play order
    this.durations = [];      // durationMs aligned with order
    this.cum = [0];           // cumulative start ms per order index
    this.baseOffsetMs = 0;
    this.onNeedMore = () => {};
    this.onBoundary = () => {};
    this.waitingForNext = false;
    this._muted = true;
    for (const el of this.els) {
      el.addEventListener('ended', () => { if (el === this.els[this.active]) this._advance(); });
    }
  }

  setup(baseOffsetMs) { this.baseOffsetMs = baseOffsetMs; return Promise.resolve(true); }

  addSegment(seq, durationMs) {
    this.order.push(seq);
    this.durations.push(durationMs);
    this.cum.push(this.cum[this.cum.length - 1] + durationMs);
    if (this.index === -1) this._playAt(0);
    else if (this.waitingForNext && this.index + 1 === this.order.length - 1) {
      this.waitingForNext = false;
      this._advance();
    } else {
      this._preload(this.index + 1);
    }
  }

  _el(which) { return this.els[which]; }

  _load(which, orderIdx) {
    const el = this._el(which);
    if (this.playing[which] === orderIdx && el.src) return;
    el.src = this.urlFor(this.order[orderIdx]);
    el.muted = this._muted;
    el.load();
    this.playing[which] = orderIdx;
  }

  _playAt(orderIdx, offsetSec = 0) {
    if (orderIdx >= this.order.length) { this.waitingForNext = true; return; }
    this.index = orderIdx;
    this._load(this.active, orderIdx);
    const el = this._el(this.active);
    const start = () => {
      if (offsetSec) { try { el.currentTime = offsetSec; } catch { /* not seekable yet */ } }
      el.play().catch(() => { /* needs gesture; overlay handles it */ });
    };
    if (el.readyState >= 1) start();
    else el.addEventListener('loadedmetadata', start, { once: true });
    this._swapVisible();
    this._preload(orderIdx + 1);
  }

  _preload(orderIdx) {
    if (orderIdx >= this.order.length) return;
    this._load(1 - this.active, orderIdx);
  }

  _advance() {
    const next = this.index + 1;
    this.onBoundary();
    if (next >= this.order.length) { this.waitingForNext = true; this.onNeedMore(); return; }
    const standby = 1 - this.active;
    if (this.playing[standby] === next) {
      this.active = standby;
      const el = this._el(this.active);
      el.muted = this._muted;
      el.play().catch(() => { /* gesture needed */ });
      this._swapVisible();
      this.index = next;
      this._preload(next + 1);
    } else {
      this._playAt(next);
    }
    this.onNeedMore();
  }

  _swapVisible() {
    this.els[this.active].classList.add('vid-active');
    this.els[1 - this.active].classList.remove('vid-active');
  }

  get video() { return this._el(this.active); }

  set muted(m) { this._muted = m; for (const el of this.els) el.muted = m; }
  get muted() { return this._muted; }

  play() { return this.video.play(); }
  pause() { for (const el of this.els) el.pause(); }
  get paused() { return this.video.paused; }

  bufferedAheadMs() {
    if (this.index === -1) return 0;
    const el = this.video;
    const remainThis = Math.max(0, (this.durations[this.index] || 0) - el.currentTime * 1000);
    const standbyReady = this.playing[1 - this.active] === this.index + 1 &&
      this._el(1 - this.active).readyState >= 3;
    return remainThis + (standbyReady ? this.durations[this.index + 1] || 0 : 0);
  }

  globalTimeMs() {
    if (this.index === -1) return this.baseOffsetMs;
    return this.baseOffsetMs + this.cum[this.index] + this.video.currentTime * 1000;
  }

  seekGlobalMs(globalMs) {
    const local = globalMs - this.baseOffsetMs;
    let idx = 0;
    while (idx + 1 < this.order.length && this.cum[idx + 1] <= local) idx++;
    const offset = Math.max(0, (local - this.cum[idx]) / 1000);
    this.waitingForNext = false;
    this._playAt(idx, offset);
    return true;
  }

  jumpToEnd() {
    if (this.order.length) this._playAt(this.order.length - 1);
  }

  finalize() { /* nothing to close in this engine */ }

  destroy() {
    for (const el of this.els) {
      el.pause();
      el.removeAttribute('src');
      try { el.load(); } catch { /* ignore */ }
    }
  }
}

/* ------------------------------------------------------------ controller */

class PlayerController {
  /**
   * @param {{video:HTMLVideoElement, videoB:HTMLVideoElement, sessionId:string,
   *          mime:string, onStatus:(st:object)=>void}} opts
   */
  constructor(opts) {
    this.o = opts;
    this.sessionId = opts.sessionId;
    this.mime = opts.mime;
    this.engine = null;
    this.engineKind = null;
    this.known = new Map();      // seq -> {d, s}
    this.orderedSeqs = [];       // sorted seqs
    this.cumBySeq = new Map();   // seq -> global start ms
    this.totalMs = 0;
    this.nextFetchSeq = 0;       // next seq the engine wants
    this.fetching = false;
    this.live = true;
    this.endedRemote = false;
    this.holeSince = 0;
    this.destroyed = false;
    this.followLive = true;
    this._fetchTimer = null;
  }

  mediaUrl(seq) {
    const k = viewerKey();
    return `/media/${encodeURIComponent(this.sessionId)}/${seq}${k ? `?k=${encodeURIComponent(k)}` : ''}`;
  }

  /** Feed playlist metadata (idempotent). Returns count of new segments. */
  addSegments(segs) {
    let added = 0;
    for (const s of segs) {
      if (this.known.has(s.seq)) continue;
      this.known.set(s.seq, { d: s.d, s: s.s });
      added++;
    }
    if (added) {
      this.orderedSeqs = [...this.known.keys()].sort((a, b) => a - b);
      this.totalMs = 0;
      this.cumBySeq.clear();
      for (const seq of this.orderedSeqs) {
        this.cumBySeq.set(seq, this.totalMs);
        this.totalMs += this.known.get(seq).d;
      }
      this._scheduleFetch();
    }
    return added;
  }

  latestSeq() { return this.orderedSeqs.length ? this.orderedSeqs[this.orderedSeqs.length - 1] : -1; }

  async start({ live }) {
    this.live = live;
    const nativeOk = mimePlayableNatively(this.o.video, this.mime);
    const mseOk = mimeMseSupported(this.mime) && !store.get(`mseBad.${this.mime}`);
    if (!mseOk && !nativeOk) {
      this.o.onStatus({ fatal: `This device cannot play this stream's format (${this.mime.split(';')[0]}). ` +
        (this.mime.includes('webm') ? 'iPhones cannot play WebM — try a laptop or Android device, or ask the broadcaster to use MP4.' : '') });
      return false;
    }
    const startSeq = live && this.orderedSeqs.length > 3
      ? this.orderedSeqs[this.orderedSeqs.length - 3]
      : (this.orderedSeqs[0] ?? 0);
    await this._startEngine(mseOk ? 'mse' : 'seq', startSeq);
    return true;
  }

  async _startEngine(kind, startSeq, offsetInSegMs = 0) {
    this.engineKind = kind;
    this.nextFetchSeq = startSeq;
    const base = this.cumBySeq.get(startSeq) ?? 0;
    if (kind === 'mse') {
      this.engine = new MsePlayer(this.o.video, this.mime, (err) => this._mseFailed(err));
      this.o.video.classList.add('vid-active');
      this.o.videoB.classList.remove('vid-active');
      const ok = await this.engine.setup(base);
      if (!ok) return; // _mseFailed already rerouting
    } else {
      this.engine = new SeqPlayer(this.o.video, this.o.videoB, (seq) => this.mediaUrl(seq));
      this.engine.onNeedMore = () => this._scheduleFetch();
      await this.engine.setup(base);
    }
    this._offsetPending = offsetInSegMs;
    this._scheduleFetch();
  }

  _mseFailed(err) {
    // Typical cause: MP4 from a recorder that is not MSE-fragmented.
    // Remember and fall back to native sequential playback.
    if (this.destroyed || this.engineKind !== 'mse') return;
    store.set(`mseBad.${this.mime}`, 1);
    const resumeSeq = this._lastAppendedSeq ?? this.nextFetchSeq;
    const wasMuted = this.o.video.muted;
    try { this.engine.destroy(); } catch { /* ignore */ }
    const startSeq = this.orderedSeqs.includes(resumeSeq) ? resumeSeq : (this.orderedSeqs[0] ?? 0);
    this._startEngine('seq', startSeq).then(() => {
      this.engine.muted = wasMuted;
      this.o.onStatus({ engineSwitched: 'seq' });
    });
  }

  _scheduleFetch() {
    if (this._fetchTimer || this.destroyed) return;
    this._fetchTimer = setTimeout(() => { this._fetchTimer = null; this._fetchLoop(); }, 0);
  }

  async _fetchLoop() {
    if (this.destroyed || this.fetching || !this.engine) return;
    this.fetching = true;
    try {
      while (!this.destroyed) {
        const engine = this.engine; // an engine swap invalidates this iteration
        const aheadMs = engine.bufferedAheadMs();
        if (aheadMs > 30_000) break; // plenty buffered
        const seq = this._nextAvailableSeq();
        if (seq === null) break;
        if (this.engineKind === 'mse') {
          const meta = this.known.get(seq);
          let buf;
          try {
            const res = await fetch(this.mediaUrl(seq));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            buf = await res.arrayBuffer();
          } catch (e) {
            await new Promise((r) => setTimeout(r, 1500));
            continue; // network blip while watching: retry same seq
          }
          if (engine !== this.engine || this.destroyed) break;
          engine.append(buf, meta.d);
          this._lastAppendedSeq = seq;
          this._appendedTotalMs = (this._appendedTotalMs || 0) + meta.d;
          // Safety net: if appends never become playable buffer (e.g. an MP4
          // flavor MSE silently rejects), bail out to the native engine.
          if (this._appendedTotalMs > 20_000 && engine.bufferedEndMs() < 4000) {
            engine._fatal(new Error('MSE appends produced no playable buffer'));
            break;
          }
          if (this._offsetPending) {
            const target = engine.baseOffsetMs + this._offsetPending;
            this._offsetPending = 0;
            setTimeout(() => engine.seekWithinMs(target), 200);
          }
        } else {
          engine.addSegment(seq, this.known.get(seq).d);
          this._lastAppendedSeq = seq;
          if (this._offsetPending) {
            const off = this._offsetPending;
            this._offsetPending = 0;
            engine._playAt(0, off / 1000);
          }
        }
        if (engine !== this.engine) break;
        this.nextFetchSeq = seq + 1;
        this.holeSince = 0;
      }
      if (this.endedRemote && this.engine && this._noMoreData()) this.engine.finalize();
    } finally {
      this.fetching = false;
    }
  }

  _nextAvailableSeq() {
    if (this.known.has(this.nextFetchSeq)) return this.nextFetchSeq;
    // A hole: the broadcaster's uplink is fuzzy and a segment is late.
    const later = this.orderedSeqs.find((s) => s > this.nextFetchSeq);
    if (later === undefined) return null;
    if (!this.holeSince) this.holeSince = Date.now();
    if (Date.now() - this.holeSince > 25_000 || this.endedRemote) {
      this.holeSince = 0;
      this.nextFetchSeq = later; // play on; the hole can still fill for DVR
      return later;
    }
    return null;
  }

  _noMoreData() {
    return this.latestSeq() >= 0 && this.nextFetchSeq > this.latestSeq();
  }

  /* ---- UI-facing API ---- */

  globalTimeMs() { return this.engine ? this.engine.globalTimeMs() : 0; }
  durationMs() { return this.totalMs; }
  behindLiveMs() { return Math.max(0, this.totalMs - this.globalTimeMs()); }

  seekGlobalMs(t) {
    this.followLive = t > this.totalMs - 6000;
    if (!this.engine) return;
    if (this.engineKind === 'seq' && t >= this.engine.baseOffsetMs) {
      this.engine.seekGlobalMs(t);
      this._scheduleFetch();
      return;
    }
    if (this.engineKind === 'mse' && this.engine.seekWithinMs(t)) return;
    // Outside what the engine holds (e.g. DVR back before the live-join
    // point): rebuild the engine starting at that segment.
    let seq = this.orderedSeqs[0] ?? 0;
    for (const s of this.orderedSeqs) { if ((this.cumBySeq.get(s) ?? 0) <= t) seq = s; else break; }
    const offset = t - (this.cumBySeq.get(seq) ?? 0);
    const kind = this.engineKind;
    const wasMuted = this.engineKind === 'seq' ? this.engine.muted : this.o.video.muted;
    try { this.engine.destroy(); } catch { /* ignore */ }
    this._appendedTotalMs = 0;
    this._startEngine(kind, seq, offset).then(() => {
      if (kind === 'seq') this.engine.muted = wasMuted;
      else this.o.video.muted = wasMuted;
      this.play();
    });
  }

  goLive() {
    this.followLive = true;
    const latest = this.latestSeq();
    if (latest < 0 || !this.engine) return;
    const target = Math.max(0, this.totalMs - 2 * (this.known.get(latest)?.d || 4000));
    if (this.engineKind === 'mse') {
      if (this.nextFetchSeq >= latest - 2 && this.engine.bufferedAheadMs() > 0) this.engine.jumpToEnd();
      else this.seekGlobalMs(target);
    } else {
      this.seekGlobalMs(target);
    }
    this.play();
  }

  /** Keep close to the edge while following live. */
  maintainLive() {
    if (!this.followLive || !this.live || !this.engine) return;
    const behind = this.behindLiveMs();
    const vid = this.engineKind === 'mse' ? this.o.video : this.engine.video;
    if (behind > 20_000 && !vid.paused) this.goLive();
  }

  markEnded() {
    this.endedRemote = true;
    this.live = false;
    this._scheduleFetch();
  }

  play() {
    const v = this.engineKind === 'seq' ? this.engine : this.o.video;
    return (v.play && v.play()) || Promise.resolve();
  }
  pause() {
    if (this.engineKind === 'seq') this.engine.pause();
    else this.o.video.pause();
  }
  get paused() {
    return this.engineKind === 'seq' ? this.engine.paused : this.o.video.paused;
  }
  setMuted(m) {
    if (this.engineKind === 'seq') this.engine.muted = m;
    this.o.video.muted = m;
    this.o.videoB.muted = m;
  }

  /** Call from a user gesture: "blesses" both video elements for playback so
   * strict autoplay policies (iOS Safari) allow later programmatic swaps. */
  unlock() {
    for (const el of [this.o.video, this.o.videoB]) {
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
      if (this.engineKind === 'seq' && this.engine && el !== this.engine.video) el.pause();
      if (this.engineKind !== 'seq' && el === this.o.videoB) el.pause();
    }
  }

  activeVideo() { return this.engineKind === 'seq' && this.engine ? this.engine.video : this.o.video; }

  destroy() {
    this.destroyed = true;
    clearTimeout(this._fetchTimer);
    try { this.engine?.destroy(); } catch { /* ignore */ }
  }
}
