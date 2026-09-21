/*
 * WeddingCast service worker.
 *
 * Caches the app shell so the broadcaster app opens (and can START RECORDING)
 * with zero connectivity — segments queue on-device and upload when the
 * network returns. Media and API are always network-only: live data must
 * never be stale, and video segments are too large to double-store.
 */
'use strict';

const VERSION = 'v1';
const SHELL_CACHE = `wc-shell-${VERSION}`;
const SHELL = [
  '/',
  '/broadcast',
  '/watch/__shell',
  '/css/style.css',
  '/js/common.js',
  '/js/db.js',
  '/js/recorder.js',
  '/js/uploader.js',
  '/js/broadcast.js',
  '/js/player.js',
  '/js/watch.js',
  '/js/home.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method !== 'GET') return;                     // uploads etc: network
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return; // live data: network

  // Navigations: network first (fresh HTML), cached shell when offline.
  if (e.request.mode === 'navigate') {
    const shellPath = url.pathname.startsWith('/watch/') ? '/watch/__shell'
      : url.pathname.startsWith('/broadcast') ? '/broadcast' : '/';
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(shellPath, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(shellPath).then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets: cache first, refresh in the background.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    }),
  );
});
