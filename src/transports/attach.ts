import type { AttachedMedia, HlsTransportConfig, PlaybackSource } from "../types.js";
import { attachHls } from "./hls-js.js";
import { attachProgressive } from "./progressive.js";

export type AttachSourceOptions = HlsTransportConfig & {
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
  maxBufferSeconds?: number;
  autoStartLoad?: boolean;
  pauseAfterBufferedSeconds?: number;
  preload?: "none" | "metadata" | "auto";
};

type AttachmentState = {
  tail: Promise<void>;
  attached?: AttachedMedia;
};

const attachments = new WeakMap<HTMLAudioElement, AttachmentState>();

export async function attachSource(
  audio: HTMLAudioElement,
  source: PlaybackSource,
  opts?: AttachSourceOptions,
): Promise<AttachedMedia> {
  let state = attachments.get(audio);
  if (!state) {
    state = { tail: Promise.resolve() };
    attachments.set(audio, state);
  }
  const slot = state;
  // A stale async HLS attachment must finish/dispose before its successor
  // touches the same element. Disposing an old returned handle is then safe.
  const pending = slot.tail.then(async () => {
    if (opts?.signal?.aborted) throw new DOMException("Attachment cancelled", "AbortError");
    slot.attached?.destroy();
    let raw: AttachedMedia;
    try {
      raw = source.kind === "progressive"
        ? attachProgressive(audio, source, { preload: opts?.preload })
        : await attachHls(audio, source.url, opts);
    } catch (error) {
      if (opts?.signal?.aborted) throw new DOMException("Attachment cancelled", "AbortError");
      throw error;
    }
    if (opts?.signal?.aborted) {
      raw.destroy();
      throw new DOMException("Attachment cancelled", "AbortError");
    }
    let destroyed = false;
    const attached: AttachedMedia = {
      ...raw,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (slot.attached === attached) slot.attached = undefined;
        raw.destroy();
      },
    };
    slot.attached = attached;
    return attached;
  });
  slot.tail = pending.then(() => {}, () => {});
  return pending;
}
