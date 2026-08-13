export { AudioEngine } from "./engine.js";
export { DualAudioPool } from "./pool.js";
export {
  buildTimeline,
  findTimelineIndex,
  timelineSeekTime,
  formatClock,
  type TimelineEntry,
} from "./timeline.js";
export {
  warmProgressiveRange,
  estimatePrefetchBytes,
  PrefetchController,
  progressivePreloadFor,
  warmCacheKey,
} from "./prefetch/progressive-range.js";
export { isExpiringSoon, isAbortError, EXPIRY_SKEW_MS } from "./expiry.js";
export { canPlayNativeHls } from "./transports/native-hls.js";
export { attachHls } from "./transports/hls-js.js";
export { attachProgressive } from "./transports/progressive.js";
export { attachSource } from "./transports/attach.js";
export type {
  MediaSessionActions,
  MediaSessionActionOverrides,
} from "./media-session.js";

export type {
  ArtworkImage,
  TrackMeta,
  ProgressiveSource,
  HlsSource,
  PlaybackSource,
  ResolveContext,
  ResolvedTrack,
  ResolvedContinuous,
  SourceAdapter,
  PrefetchConfig,
  HooksConfig,
  HlsTransportConfig,
  AudioEngineOptions,
  EngineMode,
  LoadDiscreteOptions,
  LoadContinuousOptions,
  LoadOptions,
  ReplaceSourceOptions,
  TrackChangePayload,
  ProgressPayload,
  BeforeEndPayload,
  EngineEvents,
  AttachedMedia,
} from "./types.js";
