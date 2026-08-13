import type { AttachedMedia } from "../types.js";

const HLS_TYPES = [
  "application/vnd.apple.mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/x-mpegurl",
];

export function canPlayNativeHls(audio?: HTMLAudioElement): boolean {
  if (typeof document === "undefined") return false;
  const el = audio ?? document.createElement("audio");
  return HLS_TYPES.some((t) => {
    const r = el.canPlayType(t);
    return r === "probably" || r === "maybe";
  });
}

/**
 * Native AVPlayer HLS path (Safari / iOS). Prefer hls.js when MSE works —
 * Android Chrome often reports canPlayType('mpegurl') === 'maybe' but fails.
 */
export function attachNativeHls(
  audio: HTMLAudioElement,
  url: string,
): AttachedMedia {
  audio.preload = "auto";
  audio.src = url;
  return {
    destroy: () => {
      audio.pause();
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {
        /* ignore */
      }
    },
  };
}
