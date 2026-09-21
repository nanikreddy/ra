/* Shared helpers for all WeddingCast pages. */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(`wc.${k}`); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem(`wc.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(`wc.${k}`); } catch { /* ignore */ } },
};

function viewerKey() { return store.get('viewerKey', ''); }
function broadcastKey() { return store.get('broadcastKey', ''); }

/** fetch JSON from our API, attaching keys. Throws Error with .status on failure. */
async function api(path, { method = 'GET', body, key, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'Accept': 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['X-Broadcast-Key'] = key;
    if (viewerKey()) headers['X-Viewer-Key'] = viewerKey();
    const res = await fetch(path, {
      method, headers, signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

const fmt = {
  bytes(n) {
    if (!Number.isFinite(n) || n < 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  },
  dur(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
             : `${m}:${String(r).padStart(2, '0')}`;
  },
  secs(ms) { return `${Math.round(ms / 1000)}s`; },
  clock(ts) {
    return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  },
  mbps(bitsPerSec) { return `${(bitsPerSec / 1e6).toFixed(1)} Mbps`; },
  res(w, h) {
    if (!w || !h) return '';
    const long = Math.max(w, h);
    if (long >= 3800) return '4K';
    if (long >= 2500) return '1440p';
    if (long >= 1900) return 'HD 1080p';
    if (long >= 1200) return 'HD 720p';
    return `${w}×${h}`;
  },
};

let toastTimer = null;
function toast(msg, ms = 3200) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* PWA service worker (skip in e2e runs to keep tests deterministic) */
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('nosw')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* http or unsupported */ });
  });
}
