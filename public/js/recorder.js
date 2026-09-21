/*
 * SegmentRecorder — records the camera into short SELF-CONTAINED media
 * segments (default 4 s) at full HD/4K quality.
 *
 * Why segments instead of one long recording:
 *  - each segment is a complete standalone file, so it can be uploaded (and
 *    re-uploaded after a network failure) independently — nothing is ever
 *    lost or degraded by fuzzy internet;
 *  - viewers can join at the live edge without downloading history;
 *  - a crashed page or swapped phone can continue the same stream at the
 *    next segment boundary.
 *
 * Implementation: one MediaRecorder per segment. To avoid a visible gap we
 * start the next recorder BEFORE stopping the current one (a few ms of
 * encoder overlap); if the browser refuses two recorders on one stream we
 * fall back to stop-then-start (a ~50-150 ms seam every few seconds).
 */
'use strict';

/** Ordered probe lists. MP4/H.264 plays natively everywhere, including
 * iPhones; WebM gives seamless MSE playback on Chrome/Edge/Firefox/Android. */
const MIME_CHOICES = {
  mp4: [
    'video/mp4;codecs="avc1.640033,mp4a.40.2"',
    'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4',
  ],
  vp9: ['video/webm;codecs="vp9,opus"'],
  h264webm: ['video/webm;codecs="h264,opus"'],
  vp8: ['video/webm;codecs="vp8,opus"', 'video/webm'],
};

function pickMime(preference = 'auto') {
  if (typeof MediaRecorder === 'undefined') return null;
  const order = {
    // MP4 first: every guest's phone (iPhones included) can play it natively.
    auto: [...MIME_CHOICES.mp4, ...MIME_CHOICES.vp9, ...MIME_CHOICES.h264webm, ...MIME_CHOICES.vp8],
    mp4: MIME_CHOICES.mp4,
    vp9: [...MIME_CHOICES.vp9, ...MIME_CHOICES.vp8],
    vp8: MIME_CHOICES.vp8,
  }[preference] || MIME_CHOICES.vp8;
  for (const m of order) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch { /* probe */ }
  }
  return '';
}

const QUALITY_PRESETS = {
  '2160': { label: '4K · 2160p', width: 3840, height: 2160, videoBps: 34_000_000 },
  '1440': { label: 'QHD · 1440p', width: 2560, height: 1440, videoBps: 18_000_000 },
  '1080': { label: 'HD · 1080p', width: 1920, height: 1080, videoBps: 12_000_000 },
  '720': { label: 'HD · 720p', width: 1280, height: 720, videoBps: 6_000_000 },
};

class SegmentRecorder {
  /**
   * @param {MediaStream} stream
   * @param {{mimeType:string, videoBitsPerSecond:number, audioBitsPerSecond?:number,
   *          segmentMs?:number, startSeq?:number,
   *          onSegment:(blob:Blob, meta:{seq:number,durationMs:number,recordedAt:number})=>void,
   *          onError?:(err:Error)=>void}} opts
   */
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.segmentMs = Math.min(Math.max(opts.segmentMs || 4000, 1000), 60_000);
    this.seq = opts.startSeq || 0;
    this.state = 'inactive'; // inactive | recording | stopping
    this.parallelOk = true;  // two recorders may overlap during rotation
    this.actualMime = null;
    this._rec = null;
    this._timer = null;
    this._active = new Set(); // recorders whose final blob has not been delivered yet
    this._onAllFlushed = null;
  }

  start() {
    if (this.state !== 'inactive') return;
    this.state = 'recording';
    this._spawn();
  }

  _newRecorder() {
    const rec = new MediaRecorder(this.stream, {
      mimeType: this.opts.mimeType || undefined,
      videoBitsPerSecond: this.opts.videoBitsPerSecond,
      audioBitsPerSecond: this.opts.audioBitsPerSecond || 192_000,
    });
    const seg = { seq: this.seq++, chunks: [], startedAt: 0, recordedAt: Date.now() };
    rec.onstart = () => { seg.startedAt = performance.now(); };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onstop = () => {
      this._active.delete(rec);
      const durationMs = seg.startedAt
        ? Math.max(1, Math.round(performance.now() - seg.startedAt))
        : this.segmentMs;
      const blob = new Blob(seg.chunks, { type: this.actualMime || rec.mimeType || this.opts.mimeType });
      seg.chunks = null;
      if (blob.size > 0) {
        try { this.opts.onSegment(blob, { seq: seg.seq, durationMs, recordedAt: seg.recordedAt }); }
        catch (err) { this._fail(err); }
      }
      // Gap-mode rotation: the next recorder starts only after the old one stopped.
      if (this.state === 'recording' && this._rec === null) this._spawn();
      if (this._active.size === 0 && this._onAllFlushed) this._onAllFlushed();
    };
    rec.onerror = (e) => this._fail((e && e.error) || new Error('MediaRecorder error'));
    rec.start();
    this._active.add(rec);
    if (!this.actualMime) this.actualMime = rec.mimeType || this.opts.mimeType || 'video/webm';
    return rec;
  }

  _spawn() {
    try {
      this._rec = this._newRecorder();
    } catch (err) {
      this._fail(err);
      return;
    }
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._rotate(), this.segmentMs);
  }

  _rotate() {
    if (this.state !== 'recording') return;
    const old = this._rec;
    let overlapped = false;
    if (this.parallelOk) {
      try {
        this._rec = this._newRecorder(); // start the successor first: no gap
        overlapped = true;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._rotate(), this.segmentMs);
      } catch {
        this.parallelOk = false; // this browser wants one recorder at a time
      }
    }
    if (!overlapped) this._rec = null; // old.onstop will _spawn() the successor
    try { if (old && old.state !== 'inactive') old.stop(); }
    catch { if (!overlapped && this.state === 'recording') this._spawn(); }
  }

  /** Stop recording; resolves once every segment has been delivered. */
  stop() {
    if (this.state !== 'recording') return Promise.resolve();
    this.state = 'stopping';
    clearTimeout(this._timer);
    const pending = [...this._active];
    this._rec = null;
    return new Promise((resolve) => {
      const done = () => { this.state = 'inactive'; this._onAllFlushed = null; resolve(); };
      if (pending.length === 0) return done();
      this._onAllFlushed = done;
      for (const rec of pending) {
        try { if (rec.state !== 'inactive') rec.stop(); else this._active.delete(rec); } catch { this._active.delete(rec); }
      }
      if (this._active.size === 0) done();
      setTimeout(() => { if (this._onAllFlushed) done(); }, 3000); // safety net
    });
  }

  _fail(err) {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    clearTimeout(this._timer);
    for (const rec of [...this._active]) {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* ignore */ }
    }
    this._rec = null;
    if (this.opts.onError) this.opts.onError(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Open the camera at (up to) the requested quality; falls back gracefully. */
async function openCamera({ preset = '1080', videoDeviceId, audioDeviceId, facingMode = 'environment', audioProcessing = false, frameRate = 30 }) {
  const q = QUALITY_PRESETS[preset] || QUALITY_PRESETS['1080'];
  const audio = {
    deviceId: audioDeviceId ? { exact: audioDeviceId } : undefined,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
    // Weddings have music and vows, not conference calls: keep the sound raw
    // unless the user opts into voice processing.
    echoCancellation: audioProcessing,
    noiseSuppression: audioProcessing,
    autoGainControl: audioProcessing,
  };
  const tries = [
    { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: frameRate } },
    { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: frameRate } },
    { width: { ideal: 1280 }, height: { ideal: 720 } },
    {},
  ];
  let lastErr = null;
  for (const dims of tries) {
    const video = {
      ...dims,
      deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
      facingMode: videoDeviceId ? undefined : facingMode,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio });
      const track = stream.getVideoTracks()[0];
      if (track && 'contentHint' in track) track.contentHint = 'motion';
      return stream;
    } catch (e) {
      lastErr = e;
      if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') throw e;
      // OverconstrainedError etc: try the next, smaller tier
    }
  }
  throw lastErr || new Error('could not open camera');
}
