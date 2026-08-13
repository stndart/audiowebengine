import type { TrackMeta } from "./types.js";

export type MediaSessionActions = {
  play: () => void | Promise<void>;
  pause: () => void;
  previoustrack: () => void | Promise<void>;
  nexttrack: () => void | Promise<void>;
  seekto?: (details: MediaSessionActionDetails) => void;
  seekbackward?: (details: MediaSessionActionDetails) => void;
  seekforward?: (details: MediaSessionActionDetails) => void;
};

/** Partial host overrides. `null` restores the engine default for that action. */
export type MediaSessionActionOverrides = {
  [K in keyof MediaSessionActions]?: MediaSessionActions[K] | null;
};

export function updateMediaSessionMetadata(meta: TrackMeta | undefined): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }
  if (!meta) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title,
    artist: meta.artist ?? "",
    album: meta.album ?? "",
    artwork: (meta.artwork ?? []).map((a) => ({
      src: a.src,
      sizes: a.sizes,
      type: a.type,
    })),
  });
}

export function setMediaSessionPlaybackState(
  state: MediaSessionPlaybackState,
): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }
  navigator.mediaSession.playbackState = state;
}

export function bindMediaSessionActions(actions: MediaSessionActions): () => void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return () => {};
  }

  const entries: [MediaSessionAction, MediaSessionActionHandler][] = [
    ["play", () => void actions.play()],
    ["pause", () => actions.pause()],
    ["previoustrack", () => void actions.previoustrack()],
    ["nexttrack", () => void actions.nexttrack()],
  ];

  if (actions.seekto) {
    entries.push(["seekto", (d) => actions.seekto!(d)]);
  }
  if (actions.seekbackward) {
    entries.push(["seekbackward", (d) => actions.seekbackward!(d)]);
  }
  if (actions.seekforward) {
    entries.push(["seekforward", (d) => actions.seekforward!(d)]);
  }

  for (const [action, handler] of entries) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* unsupported action on this platform */
    }
  }

  return () => {
    for (const [action] of entries) {
      try {
        navigator.mediaSession.setActionHandler(action, null);
      } catch {
        /* ignore */
      }
    }
  };
}

export function updateMediaSessionPosition(opts: {
  duration: number;
  position: number;
  playbackRate?: number;
}): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return;
  }
  if (
    typeof navigator.mediaSession.setPositionState !== "function" ||
    !Number.isFinite(opts.duration) ||
    opts.duration <= 0
  ) {
    return;
  }
  try {
    navigator.mediaSession.setPositionState({
      duration: opts.duration,
      position: Math.min(Math.max(0, opts.position), opts.duration),
      playbackRate: opts.playbackRate ?? 1,
    });
  } catch {
    /* ignore invalid state */
  }
}
