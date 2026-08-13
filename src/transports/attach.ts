import type { AttachedMedia, HlsTransportConfig, PlaybackSource } from "../types.js";
import { attachHls } from "./hls-js.js";
import { attachProgressive } from "./progressive.js";

export type AttachSourceOptions = HlsTransportConfig & {
  maxBufferSeconds?: number;
  autoStartLoad?: boolean;
  pauseAfterBufferedSeconds?: number;
  preload?: "none" | "metadata" | "auto";
};

export async function attachSource(
  audio: HTMLAudioElement,
  source: PlaybackSource,
  opts?: AttachSourceOptions,
): Promise<AttachedMedia> {
  if (source.kind === "progressive") {
    return attachProgressive(audio, source, { preload: opts?.preload });
  }
  return attachHls(audio, source.url, opts);
}
