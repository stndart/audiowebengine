import type { AttachedMedia, HlsTransportConfig } from "../types.js";
import { pauseWhenBuffered } from "../prefetch/hls-buffer.js";
import { attachNativeHls, canPlayNativeHls } from "./native-hls.js";

type HlsLike = {
  on: (event: string, handler: (event: string, data: { fatal: boolean; error?: Error; details?: string }) => void) => void;
  off: (event: string, handler: (event: string, data: { fatal: boolean; error?: Error; details?: string }) => void) => void;
  loadSource: (url: string) => void;
  attachMedia: (media: HTMLMediaElement) => void;
  destroy: () => void;
  stopLoad: () => void;
  startLoad: (startPosition?: number) => void;
  pauseBuffering: () => void;
  resumeBuffering: () => void;
  config: { maxMaxBufferLength: number; maxBufferLength: number };
};

type HlsConstructor = {
  new (config?: Record<string, unknown>): HlsLike;
  isSupported: () => boolean;
  Events: { ERROR: string };
};

let hlsCtorPromise: Promise<HlsConstructor | null> | null = null;

async function loadHlsCtor(): Promise<HlsConstructor | null> {
  if (hlsCtorPromise) return hlsCtorPromise;
  hlsCtorPromise = (async () => {
    try {
      let mod: { default?: HlsConstructor } | HlsConstructor;
      try {
        mod = (await import("hls.js/light")) as
          | { default?: HlsConstructor }
          | HlsConstructor;
      } catch {
        mod = (await import("hls.js")) as {
          default?: HlsConstructor;
        } | HlsConstructor;
      }
      const Hls = (
        typeof mod === "function"
          ? mod
          : "default" in mod && mod.default
            ? mod.default
            : mod
      ) as HlsConstructor;
      return typeof Hls?.isSupported === "function" ? Hls : null;
    } catch {
      return null;
    }
  })();
  return hlsCtorPromise;
}

export type AttachHlsOptions = HlsTransportConfig & {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  /** Cap buffer for warm/prefetch instances. */
  maxBufferSeconds?: number;
  /** If false, attach without starting segment load until resume. */
  autoStartLoad?: boolean;
  /** Pause loading once this many seconds are buffered (warm slot). */
  pauseAfterBufferedSeconds?: number;
};

/**
 * Prefer MSE hls.js when supported; else native HLS.
 * Matches webplayer's Android "maybe" caveat.
 */
export async function attachHls(
  audio: HTMLAudioElement,
  url: string,
  opts: AttachHlsOptions = {},
): Promise<AttachedMedia> {
  const withCredentials = opts.withCredentials ?? true;
  const maxBufferSeconds = opts.maxBufferSeconds;
  const autoStartLoad = opts.autoStartLoad ?? true;

  const Hls = await loadHlsCtor();
  if (opts.signal?.aborted) throw new DOMException("Attachment cancelled", "AbortError");
  if (Hls?.isSupported()) {
    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      autoStartLoad,
      maxBufferLength: maxBufferSeconds ?? 30,
      maxMaxBufferLength: maxBufferSeconds ?? 60,
      xhrSetup: withCredentials
        ? (xhr: XMLHttpRequest) => {
            xhr.withCredentials = true;
          }
        : undefined,
      fetchSetup: withCredentials
        ? (u: string, init: RequestInit) =>
            fetch(u, { ...init, credentials: "include" })
        : undefined,
    });
    let disposed = false;
    const onError = (_event: string, data: { fatal: boolean; error?: Error; details?: string }) => {
      if (!disposed && data.fatal) {
        opts.onError?.(data.error ?? new Error(`HLS playback failed: ${data.details ?? "unknown error"}`));
      }
    };
    hls.on(Hls.Events.ERROR, onError);
    hls.loadSource(url);
    hls.attachMedia(audio);

    let stopWarmPause: (() => void) | undefined;
    const attached: AttachedMedia = {
      destroy: () => {
        disposed = true;
        hls.off(Hls.Events.ERROR, onError);
        stopWarmPause?.();
        audio.pause();
        hls.destroy();
        audio.removeAttribute("src");
        try {
          audio.load();
        } catch {
          /* ignore */
        }
      },
      setMaxBufferSeconds: (seconds: number) => {
        hls.config.maxBufferLength = seconds;
        hls.config.maxMaxBufferLength = seconds;
      },
      pauseBuffering: () => {
        try {
          hls.pauseBuffering();
        } catch {
          hls.stopLoad();
        }
      },
      resumeBuffering: () => {
        try {
          hls.resumeBuffering();
        } catch {
          hls.startLoad();
        }
      },
    };

    if (
      opts.pauseAfterBufferedSeconds != null &&
      opts.pauseAfterBufferedSeconds > 0
    ) {
      stopWarmPause = pauseWhenBuffered(
        audio,
        attached,
        opts.pauseAfterBufferedSeconds,
      );
    }

    return attached;
  }

  if (canPlayNativeHls(audio)) {
    return attachNativeHls(audio, url);
  }

  throw new Error("HLS playback is not supported in this browser");
}
