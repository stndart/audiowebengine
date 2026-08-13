import { isAbortError } from "../expiry.js";
import type { ProgressiveSource } from "../types.js";

const DEFAULT_BITRATE = 1_000_000; // ~1 Mbps FLAC-ish

export function estimatePrefetchBytes(
  seconds: number,
  byteRateHint?: number,
  defaultBitrate = DEFAULT_BITRATE,
): number {
  const bytesPerSec = byteRateHint ?? defaultBitrate / 8;
  return Math.max(64_000, Math.ceil(seconds * bytesPerSec));
}

/** Warm slot must never `preload="auto"` — that can pull an entire hour-long FLAC. */
export function progressivePreloadFor(
  intent: "play" | "prefetch-next",
): "auto" | "none" {
  return intent === "play" ? "auto" : "none";
}

export type ProgressiveWarmResult = {
  url: string;
  /** Bytes downloaded for this Range request (HTTP cache may reuse them). */
  bytes: number;
  aborted: boolean;
};

/**
 * Warm the first N seconds of a progressive file via Range.
 * Does NOT replace audio.src with a blob (partial blobs truncate).
 * Does NOT write a separate Cache API key — playback still uses the network URL;
 * the browser HTTP cache is best-effort for credentialed Range vs later media GET.
 */
export async function warmProgressiveRange(
  source: ProgressiveSource,
  opts: {
    seconds: number;
    defaultBitrate?: number;
    signal?: AbortSignal;
  },
): Promise<ProgressiveWarmResult> {
  const bytes = estimatePrefetchBytes(
    opts.seconds,
    source.byteRateHint,
    opts.defaultBitrate,
  );
  const headers: HeadersInit = {
    Range: `bytes=0-${bytes - 1}`,
  };

  try {
    const res = await fetch(source.url, {
      headers,
      signal: opts.signal,
      credentials: "include",
    });

    if (opts.signal?.aborted) {
      return { url: source.url, bytes: 0, aborted: true };
    }

    if (!res.ok && res.status !== 206) {
      throw new Error(`progressive prefetch failed: HTTP ${res.status}`);
    }

    const buf = await res.arrayBuffer();
    return { url: source.url, bytes: buf.byteLength, aborted: false };
  } catch (error) {
    if (isAbortError(error) || opts.signal?.aborted) {
      return { url: source.url, bytes: 0, aborted: true };
    }
    throw error;
  }
}

/** @deprecated Playback never reads this key; kept for callers that stored warms. */
export function warmCacheKey(url: string): string {
  return `audio-engine-warm:${url}`;
}

export class PrefetchController {
  private gen = 0;
  private abort: AbortController | null = null;

  get generation(): number {
    return this.gen;
  }

  /** Invalidate in-flight prefetch work. */
  bump(): number {
    this.abort?.abort();
    this.abort = new AbortController();
    this.gen += 1;
    return this.gen;
  }

  get signal(): AbortSignal | undefined {
    return this.abort?.signal;
  }

  destroy(): void {
    this.abort?.abort();
    this.abort = null;
  }
}
