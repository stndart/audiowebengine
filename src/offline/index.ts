/**
 * Offline / PWA helpers for Phase 3.
 *
 * Design:
 * - Metadata + playlist order → IndexedDB (`OfflineCatalog`)
 * - Audio bytes → Cache API (store complete 200 responses; SW slices Range)
 * - HLS: download segments, rewrite m3u8 to same-origin cache URLs
 *
 * Remux stays serverside. Client only stores and rewrites playlists.
 * AudioEngine does not play from this catalog until the app registers
 * RANGE_SW_HANDLER_SNIPPET and points sources at offlinePlaybackUrl().
 */

export type OfflineTrackRecord = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  duration?: number;
  /** Progressive file URL that was cached (original), or local cache key. */
  sourceUrl?: string;
  cachedAt: number;
  bytes?: number;
};

export type OfflinePlaylistRecord = {
  id: string;
  title: string;
  trackIds: string[];
  updatedAt: number;
};

const DB_NAME = "audio-engine-offline";
const DB_VERSION = 1;
const STORE_TRACKS = "tracks";
const STORE_PLAYLISTS = "playlists";
export const OFFLINE_CACHE_NAME = "audio-engine-offline-v1";
/** Same-origin path the app SW must intercept (cross-origin URLs never hit the page SW). */
export const OFFLINE_SW_PATH = "/__audio-engine-offline";

export function offlinePlaybackUrl(
  originalUrl: string,
  origin?: string,
): string {
  const path = `${OFFLINE_SW_PATH}?u=${encodeURIComponent(originalUrl)}`;
  const base =
    origin ??
    (typeof location !== "undefined" ? location.origin : undefined);
  return base ? new URL(path, base).href : path;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRACKS)) {
        db.createObjectStore(STORE_TRACKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_PLAYLISTS)) {
        db.createObjectStore(STORE_PLAYLISTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class OfflineCatalog {
  async putTrack(record: OfflineTrackRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_TRACKS, "readwrite");
    await idbReq(tx.objectStore(STORE_TRACKS).put(record));
    db.close();
  }

  async getTrack(id: string): Promise<OfflineTrackRecord | undefined> {
    const db = await openDb();
    const tx = db.transaction(STORE_TRACKS, "readonly");
    const row = await idbReq(
      tx.objectStore(STORE_TRACKS).get(id) as IDBRequest<
        OfflineTrackRecord | undefined
      >,
    );
    db.close();
    return row;
  }

  async listTracks(): Promise<OfflineTrackRecord[]> {
    const db = await openDb();
    const tx = db.transaction(STORE_TRACKS, "readonly");
    const rows = await idbReq(
      tx.objectStore(STORE_TRACKS).getAll() as IDBRequest<OfflineTrackRecord[]>,
    );
    db.close();
    return rows;
  }

  async deleteTrack(id: string): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_TRACKS, "readwrite");
    await idbReq(tx.objectStore(STORE_TRACKS).delete(id));
    db.close();
  }

  async putPlaylist(record: OfflinePlaylistRecord): Promise<void> {
    const db = await openDb();
    const tx = db.transaction(STORE_PLAYLISTS, "readwrite");
    await idbReq(tx.objectStore(STORE_PLAYLISTS).put(record));
    db.close();
  }

  async getPlaylist(id: string): Promise<OfflinePlaylistRecord | undefined> {
    const db = await openDb();
    const tx = db.transaction(STORE_PLAYLISTS, "readonly");
    const row = await idbReq(
      tx.objectStore(STORE_PLAYLISTS).get(id) as IDBRequest<
        OfflinePlaylistRecord | undefined
      >,
    );
    db.close();
    return row;
  }

  async listPlaylists(): Promise<OfflinePlaylistRecord[]> {
    const db = await openDb();
    const tx = db.transaction(STORE_PLAYLISTS, "readonly");
    const rows = await idbReq(
      tx.objectStore(STORE_PLAYLISTS).getAll() as IDBRequest<
        OfflinePlaylistRecord[]
      >,
    );
    db.close();
    return rows;
  }
}

/** Cache a full progressive response (must be 200, not 206). */
export async function cacheProgressiveFile(
  url: string,
  opts?: { signal?: AbortSignal; credentials?: RequestCredentials },
): Promise<{ bytes: number }> {
  const res = await fetch(url, {
    signal: opts?.signal,
    credentials: opts?.credentials ?? "include",
  });
  if (!res.ok) {
    throw new Error(`cacheProgressiveFile failed: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  const cache = await caches.open(OFFLINE_CACHE_NAME);
  const stored = new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Length": String(buf.byteLength),
      "Accept-Ranges": "bytes",
    },
  });
  await cache.put(offlineMediaKey(url), stored);
  return { bytes: buf.byteLength };
}

export function offlineMediaKey(url: string): RequestInfo {
  return new Request(url, { method: "GET" });
}

/**
 * Parse a simple media playlist and rewrite segment URIs.
 * Handles `#EXTINF` + URI lines and byterange `EXT-X-BYTERANGE` playlists
 * that point at a single `.ts` file (your backend's single_file HLS).
 */
export function rewriteM3u8(
  manifest: string,
  mapUri: (uri: string) => string,
): string {
  const lines = manifest.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      out.push(mapUri(trimmed));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Download HLS media playlist + its segments into Cache API, return a blob:
 * URL for a rewritten local playlist.
 */
export async function cacheHlsMediaPlaylist(
  playlistUrl: string,
  opts?: { signal?: AbortSignal; credentials?: RequestCredentials },
): Promise<{ localPlaylistUrl: string; segmentCount: number }> {
  const cred = opts?.credentials ?? "include";
  const res = await fetch(playlistUrl, {
    signal: opts?.signal,
    credentials: cred,
  });
  if (!res.ok) throw new Error(`m3u8 fetch failed: ${res.status}`);
  const text = await res.text();
  const base = new URL(playlistUrl);
  const cache = await caches.open(OFFLINE_CACHE_NAME);

  const uris: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) {
      uris.push(new URL(t, base).href);
    }
  }

  // Deduplicate (single_file HLS repeats same .ts with byterange).
  const unique = [...new Set(uris)];
  for (const u of unique) {
    const seg = await fetch(u, { signal: opts?.signal, credentials: cred });
    if (!seg.ok) throw new Error(`segment fetch failed: ${seg.status} ${u}`);
    const buf = await seg.arrayBuffer();
    await cache.put(
      offlineMediaKey(u),
      new Response(buf, {
        status: 200,
        headers: {
          "Content-Type":
            seg.headers.get("Content-Type") ?? "video/mp2t",
          "Content-Length": String(buf.byteLength),
          "Accept-Ranges": "bytes",
        },
      }),
    );
  }

  const rewritten = rewriteM3u8(text, (uri) =>
    offlinePlaybackUrl(new URL(uri, base).href),
  );
  const blob = new Blob([rewritten], {
    type: "application/vnd.apple.mpegurl",
  });
  const localPlaylistUrl = URL.createObjectURL(blob);
  return { localPlaylistUrl, segmentCount: unique.length };
}

/**
 * Service worker snippet (string) for same-origin offline media + Range.
 * Register in your app's SW. AudioEngine does not register a SW itself.
 */
export const RANGE_SW_HANDLER_SNIPPET = `
// audio-engine offline handler (paste into your SW)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname !== '${OFFLINE_SW_PATH}') return;
  const original = url.searchParams.get('u');
  if (!original) return;
  event.respondWith((async () => {
    const cache = await caches.open('${OFFLINE_CACHE_NAME}');
    const full = await cache.match(original) || await cache.match(new Request(original));
    if (!full) return fetch(original);
    const buf = await full.arrayBuffer();
    const range = req.headers.get('Range');
    if (!range) {
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
          'Content-Length': String(buf.byteLength),
          'Accept-Ranges': 'bytes',
        },
      });
    }
    const m = /bytes=(\\d+)-(\\d*)/.exec(range);
    if (!m) return new Response(buf, { status: 200 });
    const start = parseInt(m[1], 10);
    const end = m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
    const slice = buf.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        'Content-Type': full.headers.get('Content-Type') || 'application/octet-stream',
        'Content-Length': String(slice.byteLength),
        'Content-Range': 'bytes ' + start + '-' + end + '/' + buf.byteLength,
        'Accept-Ranges': 'bytes',
      },
    });
  })());
});
`.trim();
