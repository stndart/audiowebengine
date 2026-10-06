/** Media Session artwork entry (subset of MediaImage). */
export type ArtworkImage = {
  src: string;
  sizes?: string;
  type?: string;
};

export type TrackMeta = {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  artwork?: ArtworkImage[];
  /** Duration in seconds. Required for continuous timeline mapping. */
  duration?: number;
};

export type ProgressiveSource = {
  kind: "progressive";
  url: string;
  mime?: string;
  /** Bytes per second hint. Unused by discrete prefetch (browser readahead); kept for `warmProgressiveRange`. */
  byteRateHint?: number;
  /** Unix milliseconds since epoch. Same clock as `Date.now()` — not a local datetime. */
  expiresAt?: number;
};

export type HlsSource = {
  kind: "hls";
  url: string;
  expiresAt?: number;
};

export type PlaybackSource = ProgressiveSource | HlsSource;

export type ResolveContext = {
  signal?: AbortSignal;
  /** Hint from engine: current track vs speculative next-track warm. */
  intent?: "play" | "prefetch-next";
};

export type ResolvedTrack = {
  source: PlaybackSource;
  meta: TrackMeta;
};

export type ResolvedContinuous = {
  source: HlsSource;
  timeline: TrackMeta[];
  /** Opaque host identity echoed on `trackchange`. Defaults to the load `queueKey`. */
  queueId?: string;
};

/**
 * App-owned API bridge. The engine never knows your REST schema.
 */
export interface SourceAdapter {
  resolve(id: string, ctx: ResolveContext): Promise<ResolvedTrack>;
  /** Optional: continuous queue m3u8 + ordered track metas. */
  resolveContinuous?(
    queueKey: string,
    ctx: ResolveContext,
  ): Promise<ResolvedContinuous>;
}

export type PrefetchConfig = {
  /** Default false — opt-in. */
  enabled?: boolean;
  /** Unused by discrete prefetch (browser readahead). Kept for `warmProgressiveRange`. */
  progressiveSeconds?: number;
  /** HLS ahead / warm buffer budget in seconds. */
  hlsAheadSeconds?: number;
  /** Unused by discrete prefetch. Default bitrate (bits/s) for `warmProgressiveRange` when byteRateHint is missing. */
  defaultBitrate?: number;
};

export type HooksConfig = {
  /** Fire `beforeend` when this many seconds remain (default 5). */
  beforeEndSeconds?: number;
  /** Fire `progress` when crossing these percentages (e.g. [30, 50, 90]). */
  progressPercents?: number[];
};

export type HlsTransportConfig = {
  /** Send cookies on HLS XHR/fetch (cross-origin credentialed). Default true. */
  withCredentials?: boolean;
};

export type AudioEngineOptions = {
  prefetch?: PrefetchConfig;
  hooks?: HooksConfig;
  hls?: HlsTransportConfig;
  /**
   * Poll interval for timeupdate / hooks (ms). Default 250.
   * Unchanged `{ currentTime, duration }` snapshots are not re-emitted;
   * seek / play / pause always emit.
   */
  timeupdateIntervalMs?: number;
};

export type EngineMode = "discrete" | "continuous";

export type LoadDiscreteOptions = {
  mode: "discrete";
  /**
   * Opaque track ids. The engine does not interpret them; each id is passed
   * back to `adapter.resolve(id)` when that track is played or prefetched.
   */
  ids: string[];
  startIndex?: number;
  /**
   * Opaque host identity for this loaded queue. Echoed on `trackchange`.
   * Not sent to the adapter — use it to decide `playAt` vs a new `load()`.
   */
  queueId?: string;
  /** Auto-play after load. Default true when user gesture likely. */
  autoplay?: boolean;
};

export type LoadContinuousOptions = {
  mode: "continuous";
  /**
   * Opaque queue key. Passed to `adapter.resolveContinuous(queueKey)`.
   * Distinct from `queueId` on the resolved payload (echoed on `trackchange`).
   */
  queueKey: string;
  startIndex?: number;
  autoplay?: boolean;
};

export type LoadOptions = LoadDiscreteOptions | LoadContinuousOptions;

export type ReplaceSourceOptions = {
  url: string;
  /** Keep absolute media clock (continuous) or currentTime (discrete). Default true. */
  preservePosition?: boolean;
};

export type TrackChangePayload = {
  track: TrackMeta;
  index: number;
  queueId?: string;
};

export type ProgressPayload = {
  percent: number;
  currentTime: number;
  duration: number;
};

export type BeforeEndPayload = {
  secondsRemaining: number;
  currentTime: number;
  duration: number;
};

export type EngineEvents = {
  play: () => void;
  pause: () => void;
  ended: () => void;
  error: (payload: { error: unknown }) => void;
  /**
   * Current track on selection (including paused loads/skips), playback
   * start/resume, and continuous timeline boundaries. Muted playback is
   * included; internal pool unlock activity is excluded.
   * The first play after selection is deduplicated; later resumes can repeat
   * the same track. History consumers tracking changes only should
   * deduplicate consecutive { queueId, index, track.id } identities.
   */
  trackchange: (payload: TrackChangePayload) => void;
  timeupdate: (payload: { currentTime: number; duration: number }) => void;
  beforeend: (payload: BeforeEndPayload) => void;
  progress: (payload: ProgressPayload) => void;
};

export type AttachedMedia = {
  destroy: () => void;
  /** Optional hls.js instance handle for buffer tuning. */
  setMaxBufferSeconds?: (seconds: number) => void;
  pauseBuffering?: () => void;
  resumeBuffering?: () => void;
};
