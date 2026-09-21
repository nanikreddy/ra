/*
 * Uploader — drains the on-device segment store to the server, reliably.
 *
 * Design rules:
 *  - Recording NEVER waits for the network. Segments land in IndexedDB and
 *    this queue pushes them out whenever it can.
 *  - A failed upload is retried forever with backoff; a retry re-sends the
 *    exact same full-quality bytes, so a flaky connection only adds delay.
 *  - Lowest sequence number first, small concurrency, so the live playlist
 *    grows almost in order and viewers stay close to the live edge.
 */
'use strict';

class Uploader {
  /**
   * @param {{sessionId:string, key:string, keepLocal:boolean, concurrency?:number,
   *          onChange?:(u:Uploader)=>void}} opts
   */
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.key = opts.key;
    this.keepLocal = Boolean(opts.keepLocal);
    this.concurrency = opts.concurrency || 2;
    this.onChange = opts.onChange || (() => {});
    this.pending = new Map();   // seq -> {seq, size, durationMs, tries, nextAt}
    this.inflight = new Map();  // seq -> {xhr, sentBytes}
    this.running = false;
    this.stalled = false;       // true after repeated failures (probably offline)
    this.bytesUploaded = 0;
    this.segmentsUploaded = 0;
    this.rateBps = 0;           // EWMA upload rate
    this._timer = null;
    this._onlineHandler = () => this._kick(true);
    window.addEventListener('online', this._onlineHandler);
  }

  /** Register a segment already persisted in SegmentDB (or, if device
   * storage failed, pass the record itself as `ram` to send from memory). */
  enqueue({ seq, size, durationMs, ram }) {
    if (this.pending.has(seq) || this.inflight.has(seq)) return;
    this.pending.set(seq, { seq, size, durationMs, ram: ram || null, tries: 0, nextAt: 0 });
    this._kick();
  }

  start() { this.running = true; this._kick(); }

  /** Resolves when the queue is fully drained (or stop() was called). */
  drain() {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.running || (this.pending.size === 0 && this.inflight.size === 0)) {
          this._drainWaiter = null;
          resolve();
        } else {
          this._drainWaiter = check;
        }
      };
      check();
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    for (const { xhr } of this.inflight.values()) { try { xhr.abort(); } catch { /* ignore */ } }
    this.inflight.clear();
    window.removeEventListener('online', this._onlineHandler);
    if (this._drainWaiter) this._drainWaiter();
  }

  stats() {
    let pendingBytes = 0, pendingMs = 0;
    for (const p of this.pending.values()) { pendingBytes += p.size; pendingMs += p.durationMs; }
    for (const f of this.inflight.keys()) {
      const rec = this._inflightMeta?.get(f);
      if (rec) { pendingBytes += rec.size; pendingMs += rec.durationMs; }
    }
    return {
      pendingSegments: this.pending.size + this.inflight.size,
      pendingBytes,
      pendingMs,
      stalled: this.stalled,
      rateBps: this.rateBps,
      uploadedSegments: this.segmentsUploaded,
      uploadedBytes: this.bytesUploaded,
    };
  }

  _kick(resetBackoff = false) {
    if (!this.running) return;
    if (resetBackoff) {
      this.stalled = false;
      for (const p of this.pending.values()) { p.nextAt = 0; }
    }
    clearTimeout(this._timer);
    const nowTs = Date.now();
    let nextWake = Infinity;
    while (this.inflight.size < this.concurrency) {
      let best = null;
      for (const p of this.pending.values()) {
        if (p.nextAt > nowTs) { nextWake = Math.min(nextWake, p.nextAt); continue; }
        if (!best || p.seq < best.seq) best = p;
      }
      if (!best) break;
      this.pending.delete(best.seq);
      this._send(best);
    }
    if (nextWake < Infinity) {
      this._timer = setTimeout(() => this._kick(), Math.max(50, nextWake - nowTs));
    }
    if (this._drainWaiter) this._drainWaiter();
    this.onChange(this);
  }

  async _send(item) {
    this._inflightMeta = this._inflightMeta || new Map();
    this._inflightMeta.set(item.seq, item);
    this.inflight.set(item.seq, { xhr: null, sentBytes: 0 });
    let record;
    try {
      record = await SegmentDB.getSegment(this.sessionId, item.seq);
    } catch (e) {
      record = null;
    }
    if ((!record || !record.blob) && item.ram) record = item.ram;
    if (!record || !record.blob) {
      // nothing to send (already gone) — treat as done
      this.inflight.delete(item.seq);
      this._inflightMeta.delete(item.seq);
      this._kick();
      return;
    }
    const startedAt = Date.now();
    const xhr = new XMLHttpRequest();
    const entry = this.inflight.get(item.seq);
    entry.xhr = xhr;

    let lastProgressAt = Date.now();
    const deadman = setInterval(() => {
      if (Date.now() - lastProgressAt > 30_000) { try { xhr.abort(); } catch { /* ignore */ } }
    }, 5000);

    const finish = (ok) => {
      clearInterval(deadman);
      this.inflight.delete(item.seq);
      this._inflightMeta.delete(item.seq);
      if (ok) {
        const secs = Math.max(0.05, (Date.now() - startedAt) / 1000);
        const rate = record.blob.size / secs;
        this.rateBps = this.rateBps ? this.rateBps * 0.7 + rate * 0.3 : rate;
        this.stalled = false;
        this.bytesUploaded += record.blob.size;
        this.segmentsUploaded += 1;
        SegmentDB.markUploaded(this.sessionId, item.seq, this.keepLocal).catch(() => {});
      } else {
        item.tries += 1;
        const backoff = Math.min(30_000, 1000 * 1.6 ** Math.min(item.tries, 8));
        item.nextAt = Date.now() + backoff;
        this.pending.set(item.seq, item);
        if (item.tries >= 2 || !navigator.onLine) this.stalled = true;
      }
      this._kick();
    };

    xhr.upload.onprogress = (e) => { lastProgressAt = Date.now(); entry.sentBytes = e.loaded || 0; this.onChange(this); };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => finish(false);
    xhr.onabort = () => finish(false);
    xhr.ontimeout = () => finish(false);

    xhr.open('POST', `/api/sessions/${encodeURIComponent(this.sessionId)}/segments/${item.seq}`);
    xhr.setRequestHeader('X-Broadcast-Key', this.key);
    xhr.setRequestHeader('Content-Type', record.mime || 'application/octet-stream');
    xhr.setRequestHeader('X-Duration-Ms', String(Math.round(record.durationMs || 0)));
    if (record.width) xhr.setRequestHeader('X-Width', String(record.width));
    if (record.height) xhr.setRequestHeader('X-Height', String(record.height));
    try {
      xhr.send(record.blob);
    } catch (e) {
      finish(false);
    }
  }
}
