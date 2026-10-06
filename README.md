# @homeweblab/audio-engine

Framework-agnostic dual-mode audio engine for music apps (SvelteKit-friendly).

- **Discrete mode** — per-track progressive / HLS URLs, dual `<audio>` pool, next-track warm via `preload="auto"`
- **Continuous mode** — queue-level m3u8 + virtual timeline (like HomeWebLab webplayer)
- Events: `play`, `pause`, `trackchange` (queue/track identity changes), `trackclear`, `timeupdate`, `beforeend`, `progress`, `ended`, `error`
- Media Session API
- Optional `./svelte` store binding and `./offline` Cache/IDB helpers
- Lazy `hls.js/light` (peer); native HLS on Safari/iOS

Not published to npm yet.

## Install into webfront-dev (day one)

Sibling folders under `HomeWebLab`:

```json
// webfront-dev/package.json
"dependencies": {
  "@homeweblab/audio-engine": "file:../webfront-audio-engine"
}
```

Then:

```bash
cd webfront-audio-engine && npm install && npm run build
cd ../webfront-dev && npm install
```

Vite resolves the `file:` package via its `exports` → `dist/`.

Later you can switch to a GitHub URL without changing import paths:

```json
"@homeweblab/audio-engine": "github:your-org/webfront-audio-engine#v0.1.0"
```

## API reference

See **[docs/api.md](./docs/api.md)** for the full `AudioEngine` surface: lifecycle,
`unlock()` (browser autoplay priming — not a mutex), `load` / `playAt`, events,
adapter contract, Media Session overrides, and discrete vs continuous behavior.

## Quick usage

```ts
import { AudioEngine } from "@homeweblab/audio-engine";
import type { SourceAdapter } from "@homeweblab/audio-engine";

const engine = new AudioEngine({
  prefetch: { enabled: true, progressiveSeconds: 12, hlsAheadSeconds: 15 },
  hooks: { beforeEndSeconds: 5, progressPercents: [30] },
});

const adapter: SourceAdapter = {
  async resolve(id, { signal }) {
    // `id` is whatever you put in load({ ids }) — e.g. GET /tracks/${id}
    return {
      source: { kind: "progressive", url: "...", mime: "audio/flac" },
      meta: { id, title: "…", duration: 240 },
    };
  },
  async resolveContinuous(queueKey) {
    // `queueKey` is whatever you put in load({ queueKey })
    return {
      source: { kind: "hls", url: "https://…/queue/…/hls?…" },
      timeline: [/* TrackMeta with duration */],
      queueId: queueKey, // optional; echoed on trackchange
    };
  },
};

engine.setAdapter(adapter).mount();

// From a click/tap: prime both <audio> elements for later autoplay (iOS).
await engine.unlock();

await engine.load({
  mode: "discrete",
  ids: ["trk_abc", "trk_def", "trk_ghi"],
  queueId: "playlist:42",
  startIndex: 0,
});

// Prefetch of the next track runs automatically on `beforeend` when enabled.
engine.on("progress", ({ percent }) => console.log("telemetry", percent));
```

Svelte:

```ts
import { createAudioStore } from "@homeweblab/audio-engine/svelte";
const store = createAudioStore(engine);
```

## Opaque ids

`ids`, `queueId`, and `queueKey` are opaque in this package. The engine does not parse them or call your API; they re-enter your code only through `SourceAdapter` (or as `queueId` on `trackchange`).

```ts
await engine.load({
  mode: "discrete",
  ids: ["trk_abc", "trk_def"], // later: adapter.resolve("trk_abc")
  queueId: "playlist:42",      // host identity only; echoed on trackchange
});

await engine.load({
  mode: "continuous",
  queueKey: "playlist:42",     // later: adapter.resolveContinuous("playlist:42")
});
```

| Token | Where you pass it | Where it comes back |
|---|---|---|
| `ids[i]` | `load({ mode: "discrete", ids })` | `adapter.resolve(id)` when that track is played or prefetched |
| `queueId` | discrete `load({ queueId })`, or continuous adapter return | `trackchange` payload / `engine.queueId` — so the host can `playAt` instead of `load()` |
| `queueKey` | `load({ mode: "continuous", queueKey })` | `adapter.resolveContinuous(queueKey)` |

`queueId` and `queueKey` are often the same string in the app (a playlist id). The engine does not equate them.

## Media Session

Headset / lock-screen buttons are wired by the engine (play, pause, next, previous, seek, ±10s). A UI wrapper around `previous()` does **not** run for those buttons.

Override via `setMediaSessionActions` — do not call `navigator.mediaSession.setActionHandler` yourself (the engine owns the handlers; overrides survive `load()` / track change):

```ts
engine.setMediaSessionActions({
  previoustrack: () => {
    if (engine.currentTime > 3) void engine.seek(0);
    else void engine.previous();
  },
});
```

Any action can be overridden (`play`, `pause`, `nexttrack`, `previoustrack`, `seekto`, `seekbackward`, `seekforward`). See **[docs/api.md](./docs/api.md#media-session)**.

## Prefetch

Opt-in via `prefetch.enabled`. When on, discrete mode warms the next track on `beforeend` (default 5s remaining). You do not need to call `prefetchNext()` yourself unless you want it earlier.

- **Progressive:** attach the next URL to the warm `<audio>` with `preload="auto"` and `load()` so the element buffers. Promote reuses that node; later Range `206`s are the media pipeline continuing, not a discarded `fetch()`. Browser readahead caps how much of a long FLAC is pulled — there is no exact second budget. Partial bodies are never used as `src` (truncation). Desktop and iOS **foreground**; iOS **background** auto-advance is continuous HLS, not this path.
- **HLS:** second instance with `maxMaxBufferLength` ≈ `hlsAheadSeconds`, then `pauseBuffering` once that much is buffered.
- Signed URLs: pass `expiresAt` as Unix milliseconds (`Date.now()` clock). Warms inside a 15s skew window are skipped / not promoted.

## Offline helpers (not wired to playback)

```ts
import {
  OfflineCatalog,
  cacheProgressiveFile,
  cacheHlsMediaPlaylist,
  offlinePlaybackUrl,
  RANGE_SW_HANDLER_SNIPPET,
} from "@homeweblab/audio-engine/offline";
```

`AudioEngine` does **not** play from IndexedDB/Cache yet. Helpers store bytes and rewrite HLS URIs to same-origin `/__audio-engine-offline?u=…` so a service worker can intercept them. Paste `RANGE_SW_HANDLER_SNIPPET` into your app SW, then point adapter URLs at `offlinePlaybackUrl(original)`. Capacitor / Android background audio is not in this package.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run build` | Emit `dist/` (ESM + d.ts) |
| `npm run dev` | Watch build |
| `npm test` | Timeline / prefetch / hooks unit tests |
| `npm run typecheck` | `tsc --noEmit` |

## Architecture notes

- App owns **SourceAdapter** (API schema stays out of this package).
- Progressive prefetch attaches the next URL with `preload="auto"` so the warm element buffers. Do not use a partial Range body as `src`.
- Prefer **hls.js light when `Hls.isSupported()`**, else native HLS (Android `canPlayType` is unreliable).
