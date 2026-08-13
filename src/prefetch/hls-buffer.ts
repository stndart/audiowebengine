import type { AttachedMedia } from "../types.js";

/** Apply a hard buffer cap on a warm HLS attach (when supported). */
export function capHlsBuffer(attached: AttachedMedia, seconds: number): void {
  attached.setMaxBufferSeconds?.(seconds);
}

export function pauseHlsWarm(attached: AttachedMedia): void {
  attached.pauseBuffering?.();
}

export function resumeHlsPlayback(
  attached: AttachedMedia,
  playbackSeconds = 30,
): void {
  attached.setMaxBufferSeconds?.(playbackSeconds);
  attached.resumeBuffering?.();
}

export function bufferedAheadSeconds(audio: HTMLMediaElement): number {
  const ranges = audio.buffered;
  if (!ranges.length) return 0;
  const t = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  let ahead = 0;
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (end <= t) continue;
    if (start <= t + 0.5) {
      ahead = Math.max(ahead, end - t);
    }
  }
  return ahead;
}

/**
 * Pause HLS loading once `seconds` are buffered ahead of currentTime.
 * Returns an unsubscribe used by attach destroy.
 */
export function pauseWhenBuffered(
  audio: HTMLMediaElement,
  attached: AttachedMedia,
  seconds: number,
): () => void {
  let done = false;
  const check = () => {
    if (done) return;
    if (bufferedAheadSeconds(audio) >= seconds) {
      done = true;
      pauseHlsWarm(attached);
      cleanup();
    }
  };
  const cleanup = () => {
    audio.removeEventListener("progress", check);
    audio.removeEventListener("loadeddata", check);
  };
  audio.addEventListener("progress", check);
  audio.addEventListener("loadeddata", check);
  check();
  return () => {
    done = true;
    cleanup();
  };
}
