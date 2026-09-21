/*
 * On-device segment store (IndexedDB).
 *
 * Every recorded segment is written here FIRST, before any network attempt.
 * This is what makes fuzzy internet harmless: the full-quality recording is
 * always safe on the device, and the uploader drains this store whenever the
 * network cooperates. Survives page reloads and browser restarts.
 */
'use strict';

const SegmentDB = (() => {
  const DB_NAME = 'weddingcast';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('segments')) {
          const st = db.createObjectStore('segments', { keyPath: ['sessionId', 'seq'] });
          st.createIndex('bySession', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
    });
    return dbPromise;
  }

  function tx(storeNames, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(storeNames, mode);
      const result = fn(...storeNames.map((n) => t.objectStore(n)));
      t.oncomplete = () => resolve(result && typeof result === 'object' && '__isValue' in result ? result.__value : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    }));
  }

  const reqValue = (req) => {
    const holder = { __isValue: true, __value: undefined };
    req.onsuccess = () => { holder.__value = req.result; };
    return holder;
  };

  return {
    /** Persist one recorded segment. record: {sessionId, seq, blob, mime, durationMs, recordedAt, size, uploaded, width, height} */
    putSegment(record) { return tx(['segments'], 'readwrite', (st) => st.put(record)); },

    getSegment(sessionId, seq) {
      return tx(['segments'], 'readonly', (st) => reqValue(st.get([sessionId, seq])));
    },

    deleteSegment(sessionId, seq) {
      return tx(['segments'], 'readwrite', (st) => st.delete([sessionId, seq]));
    },

    markUploaded(sessionId, seq, keepLocal) {
      if (!keepLocal) return this.deleteSegment(sessionId, seq);
      return tx(['segments'], 'readwrite', (st) => {
        const g = st.get([sessionId, seq]);
        g.onsuccess = () => {
          if (g.result) { g.result.uploaded = 1; st.put(g.result); }
        };
      });
    },

    /** Light-weight listing (no blobs) for one session. */
    async listSegments(sessionId) {
      const rows = await tx(['segments'], 'readonly', (st) =>
        reqValue(st.index('bySession').getAll(IDBKeyRange.only(sessionId))));
      return (rows || [])
        .map((r) => ({
          sessionId: r.sessionId, seq: r.seq, size: r.size, mime: r.mime,
          durationMs: r.durationMs, recordedAt: r.recordedAt, uploaded: r.uploaded || 0,
        }))
        .sort((a, b) => a.seq - b.seq);
    },

    /** All sessions that still have any segment rows, with pending/kept stats. */
    async pendingSummary() {
      const rows = await tx(['segments'], 'readonly', (st) => reqValue(st.getAll()));
      const by = new Map();
      for (const r of rows || []) {
        let e = by.get(r.sessionId);
        if (!e) { e = { sessionId: r.sessionId, pending: 0, pendingBytes: 0, pendingMs: 0, kept: 0, keptBytes: 0, maxSeq: -1 }; by.set(r.sessionId, e); }
        if (r.uploaded) { e.kept++; e.keptBytes += r.size || 0; }
        else { e.pending++; e.pendingBytes += r.size || 0; e.pendingMs += r.durationMs || 0; }
        if (r.seq > e.maxSeq) e.maxSeq = r.seq;
      }
      return [...by.values()];
    },

    deleteSession(sessionId) {
      return tx(['segments', 'sessions'], 'readwrite', (segs, sess) => {
        segs.delete(IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]));
        sess.delete(sessionId);
      });
    },

    putSession(meta) { return tx(['sessions'], 'readwrite', (st) => st.put(meta)); },
    getSession(id) { return tx(['sessions'], 'readonly', (st) => reqValue(st.get(id))); },
    async allSessions() {
      const rows = await tx(['sessions'], 'readonly', (st) => reqValue(st.getAll()));
      return rows || [];
    },

    async usage() {
      try {
        const est = await navigator.storage.estimate();
        return { used: est.usage || 0, quota: est.quota || 0 };
      } catch { return { used: 0, quota: 0 }; }
    },

    async persist() {
      try { return await navigator.storage.persist(); } catch { return false; }
    },
  };
})();
