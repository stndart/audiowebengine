import type { AttachedMedia, PlaybackSource } from "../types.js";

export type AttachProgressiveOptions = {
  /** Default `auto`. Warm and play both load; `none` would leave `src` idle. */
  preload?: "none" | "metadata" | "auto";
};

export function attachProgressive(
  audio: HTMLAudioElement,
  source: Extract<PlaybackSource, { kind: "progressive" }>,
  opts: AttachProgressiveOptions = {},
): AttachedMedia {
  audio.preload = opts.preload ?? "auto";
  if (source.mime) {
    // Hint only; browsers mostly ignore type on <audio src>.
    audio.setAttribute("type", source.mime);
  }
  audio.src = source.url;
  if (audio.preload !== "none") {
    try {
      audio.load();
    } catch {
      /* ignore */
    }
  }
  return {
    destroy: () => {
      audio.pause();
      audio.removeAttribute("src");
      audio.removeAttribute("type");
      audio.preload = "none";
      try {
        audio.load();
      } catch {
        /* ignore */
      }
    },
  };
}
