# WeddingCast

Self-hosted **wedding live streaming** in full **HD and 4K** — built around one
idea: *fuzzy internet should delay the stream, never degrade it.*

The camera phone records locally in small full-quality segments, saves each one
to on-device storage **first**, and then a reliable upload queue sends them to
the server (retrying forever). Viewers watch a continuously-stitched stream a
few seconds behind real time. If the venue Wi-Fi drops for a minute, recording
continues untouched; the backlog uploads automatically when the connection
returns, and viewers catch up — in the original HD/4K quality. Nothing is ever
downscaled, re-encoded, or lost to a bad connection.

```
  Phone camera ──► SegmentRecorder ──► IndexedDB (full-quality segments, ~4 s each)
   (HD / 4K)        (MediaRecorder)        │  survives crashes & reloads
                                           ▼
                                     Upload queue ──► ┌────────────┐      ┌──────────┐
                                     retry forever    │  server.js │ ───► │ viewers  │
                                     never re-encode  │ (plain     │ HTTP │ (MSE or  │
                                     fuzzy net = only │  Node.js)  │      │ native)  │
                                     extra delay      └────────────┘      └──────────┘
```

## Features

- **HD & 4K**: 720p / 1080p / 1440p / 2160p presets with sensible bitrates
  (4K ≈ 34 Mbps), plus a custom bitrate field. The viewer receives exactly the
  recorded bits — the server never touches the video.
- **Store-and-forward resilience**: every segment is persisted on the phone
  before any upload attempt. Offline for 10 minutes? The stream pauses for
  viewers and then catches up completely.
- **Crash / dead-battery recovery**: reopen the broadcast page and it offers to
  *resume the upload* of anything still stored locally — or *continue
  broadcasting* into the same stream (even from a different phone).
- **The mobile app**: this site is an installable PWA. "Add to Home Screen" on
  the phone gives a full-screen camera app with an offline-cached shell — it
  can even *start* recording with no connectivity and upload later.
- **Viewer experience**: live badge, tap-for-sound autoplay, DVR rewind while
  live ("replay the vows"), a *"weak signal at the venue — picture is catching
  up"* notice so guests know pictures are late rather than lost, viewer count,
  and automatic replay once the stream ends.
- **Broadcast dashboard**: encode bitrate, upload speed, backlog seconds,
  viewer count, device storage, wake-lock so the screen never sleeps, and a
  banner that always tells the operator what the network is doing.
- **Zero dependencies**: the server is one file of plain Node.js (≥ 18).
  `node server.js` is the whole deployment.

## Quick start

```bash
node server.js
```

The console prints:

- the site URL (share with guests),
- `/broadcast` (open on the camera phone),
- the **broadcast key** (generated on first run, stored in `data/config.json`).

Configuration is all environment variables:

| Variable         | Default        | Meaning                                          |
| ---------------- | -------------- | ------------------------------------------------ |
| `PORT`           | `8000`         | Listen port                                      |
| `HOST`           | `0.0.0.0`      | Bind address                                     |
| `SITE_TITLE`     | `Our Wedding`  | Name shown to guests                             |
| `DATA_DIR`       | `./data`       | Where streams are stored                         |
| `BROADCAST_KEY`  | *generated*    | Required to broadcast                            |
| `VIEWER_KEY`     | *(none)*       | If set, guests must enter this code to watch     |
| `MAX_SEGMENT_MB` | `200`          | Upload size guard                                |
| `TLS_CERT`/`TLS_KEY` | *(none)*   | Serve HTTPS directly (see below)                 |

```bash
SITE_TITLE="Priya & Rakesh" VIEWER_KEY=rosegarden node server.js
```

## HTTPS for phones (required for the camera)

Browsers only unlock the camera on **secure origins** (`https://…` or
`localhost`). Any one of these works:

1. **Reverse proxy with a real certificate** (best): put
   [Caddy](https://caddyserver.com) in front — `caddy reverse-proxy --from
   wedding.example.com --to localhost:8000` gets a Let's Encrypt certificate
   automatically. nginx + certbot works the same way.
2. **Tailscale**: `tailscale serve 8000` gives every device on your tailnet a
   trusted HTTPS URL — great for a private family stream.
3. **Self-signed** (LAN-only, phones will show a warning once):

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
     -days 30 -subj "/CN=weddingcast"
   TLS_CERT=cert.pem TLS_KEY=key.pem node server.js
   ```

## The mobile app (PWA)

On the camera phone and for guests alike: open the site → browser menu →
**Add to Home Screen** / **Install app**. You get a standalone full-screen app
with its own icon. The app shell is cached offline, so the broadcaster app
opens — and records — even with zero signal; footage uploads when the network
reappears.

## Wedding-day checklist (broadcaster)

1. **The night before**: install the PWA on the camera phone, enter the
   broadcast key once (it is remembered), and run a 2-minute test stream on the
   venue Wi-Fi. Check the *upload speed* stat against your chosen quality.
2. Plug the phone into power; a warm phone throttles — avoid direct sun. Use a
   tripod. Keep the screen on (the app holds a wake lock while live).
3. Pick quality by **uplink budget** (backlog grows when uplink < encode rate —
   nothing is lost, viewers just drift behind; it catches up in quiet moments):

   | Preset | Encode rate | Sustained uplink to stay live | 1 h of footage |
   | ------ | ----------- | ----------------------------- | -------------- |
   | 720p   | ~6 Mbps     | ≥ 8 Mbps                      | ~2.7 GB        |
   | 1080p  | ~12 Mbps    | ≥ 15 Mbps                     | ~5.4 GB        |
   | 1440p  | ~18 Mbps    | ≥ 23 Mbps                     | ~8 GB          |
   | 4K     | ~34 Mbps    | ≥ 42 Mbps                     | ~15 GB         |

   With **"keep a local copy"** on (default), the phone needs that much free
   storage too — the payoff is a second copy of the whole wedding.
4. **Format**: leave on *Auto*. It prefers MP4/H.264, which every guest's
   phone — iPhones included — can play. Pick WebM/VP9 only if you know your
   viewers are on Chrome/Android and want perfectly seamless playback.
5. Tap **Go live**, send the share link to the family group chat, done.
6. If the phone dies or the page crashes: reopen the app → **Continue
   broadcasting** (same link keeps working) or **Resume upload** later.

## After the wedding

Every stream stays watchable at its link (DVR + replay). To produce a single
keepsake file, stitch the segments **losslessly** (no re-encode, original
quality):

```bash
node tools/stitch.mjs --list          # see recorded sessions
node tools/stitch.mjs <sessionId>     # writes one .mp4/.webm next to the data
```

(Uses ffmpeg when available; otherwise it writes the concat list and prints the
exact command to run on a machine that has it.)

## Browser support

| Role | Chrome / Edge / Android | Safari / iPhone | Firefox |
| ---- | ----------------------- | --------------- | ------- |
| Broadcast | ✅ up to 4K (MP4 or WebM) | ✅ (MP4; resolution per device) | ✅ (WebM) |
| Watch MP4 streams | ✅ | ✅ (incl. iPhone) | ✅ |
| Watch WebM streams | ✅ seamless (MSE) | ❌ iPhones can't play WebM | ✅ |

Playback picks the best engine automatically: MediaSource (seamless, with
ManagedMediaSource on iOS 17+) and, when MSE can't handle the recording, a
preloaded dual-`<video>` player with a barely-visible seam at segment
boundaries. If a stream truly can't play (WebM on an iPhone), the viewer gets
a clear explanation instead of a spinner.

## How it works

- The broadcaster records **self-contained ~4 s segments** (one `MediaRecorder`
  per segment; the next one starts before the previous stops, so there is no
  gap). Each segment is a complete standalone file at full quality.
- Segments go to **IndexedDB first**, then an upload queue with per-segment
  retry/backoff (XHR, progress-watchdog, resume-on-`online`). Uploads are
  idempotent (`POST /api/sessions/:id/segments/:seq`) so retries are safe.
- The server (zero-dependency Node) stores segments on disk, keeps a JSON
  manifest, and serves a **playlist** viewers poll every 2 s plus the segment
  files (with Range support). Restarts rescan the disk; nothing is lost.
- Viewers append segments in order (MSE `sequence` mode) or play them
  back-to-back natively. Late joiners start near the live edge; holes caused by
  a fuzzy uplink are waited on briefly, skipped if needed, and backfill for DVR.
- Session ids are client-generated, so a broadcast can **start fully offline**
  and bind to the server when the network first appears.

### API sketch

```
GET  /api/site                                   → title, whether a viewer key is needed
POST /api/sessions                               (broadcast key) create/bind, idempotent
GET  /api/sessions                               → list for the landing page
GET  /api/sessions/:id                           → summary + full segment list
GET  /api/sessions/:id/playlist?since=N&vid=V    → summary + segments after N
POST /api/sessions/:id/segments/:seq             (broadcast key) upload one segment
POST /api/sessions/:id/heartbeat                 (broadcast key) liveness + backlog info
POST /api/sessions/:id/end                       (broadcast key) close the stream
GET  /media/:id/:seq                             segment bytes (immutable, Range OK)
```

## Tests

```bash
npm test          # API suite (node:test, no dependencies)
npm run test:e2e  # full broadcast→watch flow in headless Chromium (needs `playwright`),
                  # including a mid-stream network outage and crash recovery
```

## Limitations & honest notes

- One camera per stream (start several streams for several angles; the landing
  page lists them all).
- The delay is typically 8–20 s (segment length + upload + player buffer) and
  grows while the uplink is slower than the encode rate — by design: quality
  is never sacrificed to chase real time.
- 4K encoding is heavy; long 4K streams want a recent phone, power, and shade.
  If a phone can't sustain a preset, the browser's encoder simply produces the
  best it can — the pipeline is unaffected.
- WebM streams don't play on iPhones (platform limitation) — the default
  *Auto* format avoids this by preferring MP4.
