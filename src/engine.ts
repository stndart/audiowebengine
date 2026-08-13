import { createEngineEmitter, type EngineEmitter } from "./events.js";
import {
  bindMediaSessionActions,
  type MediaSessionActionOverrides,
  type MediaSessionActions,
} from "./media-session.js";
import { ContinuousHlsMode } from "./modes/continuous-hls.js";
import { DiscreteQueueMode } from "./modes/discrete.js";
import { DualAudioPool } from "./pool.js";
import type {
  AudioEngineOptions,
  EngineEvents,
  EngineMode,
  LoadOptions,
  ReplaceSourceOptions,
  SourceAdapter,
  TrackMeta,
} from "./types.js";

/** Dual-mode playback controller. See `docs/api.md` for the host-facing API. */
export class AudioEngine {
  private readonly emitter: EngineEmitter;
  private readonly options: AudioEngineOptions;
  private pool: DualAudioPool | null = null;
  private adapter: SourceAdapter | null = null;
  private discrete: DiscreteQueueMode | null = null;
  private continuous: ContinuousHlsMode | null = null;
  private _mode: EngineMode | null = null;
  private unsubs: Array<() => void> = [];
  private sessionOverrides: MediaSessionActionOverrides = {};
  private unbindSession: (() => void) | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.emitter = createEngineEmitter();
  }

  get mode(): EngineMode | null {
    return this._mode;
  }

  get playing(): boolean {
    if (this._mode === "discrete") return this.discrete?.state.playing ?? false;
    if (this._mode === "continuous")
      return this.continuous?.state.playing ?? false;
    return false;
  }

  get currentTime(): number {
    if (this._mode === "discrete") return this.discrete?.currentTime ?? 0;
    if (this._mode === "continuous") return this.continuous?.currentTime ?? 0;
    return 0;
  }

  get duration(): number {
    if (this._mode === "discrete") return this.discrete?.duration ?? 0;
    if (this._mode === "continuous") return this.continuous?.duration ?? 0;
    return 0;
  }

  get currentIndex(): number {
    if (this._mode === "discrete") return this.discrete?.state.index ?? 0;
    if (this._mode === "continuous") return this.continuous?.state.index ?? 0;
    return 0;
  }

  get currentMeta(): TrackMeta | undefined {
    if (this._mode === "discrete") return this.discrete?.state.meta;
    if (this._mode === "continuous") return this.continuous?.state.meta;
    return undefined;
  }

  get queueId(): string | undefined {
    if (this._mode === "discrete") return this.discrete?.state.queueId;
    if (this._mode === "continuous") return this.continuous?.state.queueId;
    return undefined;
  }

  /** Underlying current media element (after mount). */
  get mediaElement(): HTMLAudioElement | null {
    return this.pool?.current ?? null;
  }

  /** App-owned URL/metadata bridge. Required before {@link load}. */
  setAdapter(adapter: SourceAdapter): this {
    this.adapter = adapter;
    return this;
  }

  /**
   * Create / attach the dual audio pool. Call once in the browser (e.g. onMount).
   * Idempotent. `load` / `unlock` will mount automatically when `document` exists.
   */
  mount(opts?: {
    current?: HTMLAudioElement;
    next?: HTMLAudioElement;
    container?: HTMLElement | Document;
  }): this {
    if (this.pool) return this;
    const withCredentials = this.options.hls?.withCredentials ?? true;
    this.pool = new DualAudioPool({
      ...opts,
      crossOrigin: withCredentials ? "use-credentials" : null,
    });
    this.bindMediaSession();
    return this;
  }

  /**
   * Prime both `<audio>` elements during a user gesture so later autoplay
   * (track swap, `load({ autoplay: true })`) is allowed on iOS/Safari.
   *
   * Not a mutex. Call from a click/tap handler **before** `load()` when the
   * host starts playback from that gesture (see `EnginePlayer.playTrack`).
   * Idempotent; also invoked from `play()`. See docs/api.md.
   */
  async unlock(): Promise<void> {
    this.ensurePool();
    await this.pool!.unlock();
  }

  /**
   * Tear down the current mode and start discrete or continuous playback.
   * Default `autoplay` is true. Same-queue jumps should use {@link playAt}.
   */
  async load(options: LoadOptions): Promise<void> {
    this.ensurePool();
    this.ensureAdapter();
    this.teardownModes();

    if (options.mode === "discrete") {
      this._mode = "discrete";
      this.discrete = new DiscreteQueueMode(
        this.pool!,
        this.emitter,
        this.adapter!,
        this.options,
      );
      await this.discrete.load(options.ids, options.startIndex ?? 0, {
        queueId: options.queueId,
        autoplay: options.autoplay,
      });
      return;
    }

    this._mode = "continuous";
    this.continuous = new ContinuousHlsMode(
      this.pool!,
      this.emitter,
      this.adapter!,
      this.options,
    );
    await this.continuous.load(options.queueKey, options.startIndex ?? 0, {
      autoplay: options.autoplay,
    });
  }

  /** Resume the current element. Unlocks the pool first. No-op if not loaded. */
  async play(): Promise<void> {
    if (this._mode === "discrete") return this.discrete!.play();
    if (this._mode === "continuous") return this.continuous!.play();
  }

  /** Pause the current element. No-op if not loaded. */
  async pause(): Promise<void> {
    if (this._mode === "discrete") this.discrete!.pause();
    else if (this._mode === "continuous") this.continuous!.pause();
  }

  /**
   * Seek in seconds. Discrete: file clock. Continuous: offset inside the
   * current logical track (not the absolute HLS clock).
   */
  async seek(time: number): Promise<void> {
    if (this._mode === "discrete") this.discrete!.seek(time);
    else if (this._mode === "continuous") this.continuous!.seek(time);
  }

  /** Next queue index. No wrap. Discrete `ended` also calls this. */
  async next(): Promise<void> {
    if (this._mode === "discrete") return this.discrete!.next();
    if (this._mode === "continuous") return this.continuous!.next();
  }

  /** Previous queue index. No wrap. No-op on the first item. */
  async previous(): Promise<void> {
    if (this._mode === "discrete") return this.discrete!.previous();
    if (this._mode === "continuous") return this.continuous!.previous();
  }

  /**
   * Jump to a queue index and play, without a full {@link load}.
   * Prefer this when `queueId` is already loaded.
   */
  async playAt(index: number): Promise<void> {
    if (this._mode === "discrete") return this.discrete!.playIndex(index);
    if (this._mode === "continuous") return this.continuous!.playAt(index);
  }

  /**
   * Discrete: warm the next track (also fired automatically on `beforeend`
   * when prefetch is enabled). Continuous: no-op (HLS ahead-buffer is internal).
   */
  async prefetchNext(): Promise<void> {
    if (this._mode === "discrete") return this.discrete!.prefetchNext();
    // Continuous: ahead-buffer is managed in the time loop.
  }

  /**
   * Hot-swap the current media URL (e.g. remux / signed URL refresh).
   * Default keeps position (discrete `currentTime`, continuous absolute clock).
   */
  async replaceSource(opts: ReplaceSourceOptions): Promise<void> {
    const preserve = opts.preservePosition ?? true;
    if (this._mode === "discrete") {
      return this.discrete!.replaceSource(opts.url, preserve);
    }
    if (this._mode === "continuous") {
      return this.continuous!.replaceSource(opts.url, preserve);
    }
  }

  /**
   * Override lock-screen / headset Media Session actions. Unspecified keys keep
   * the previous override (or the engine default). Pass `null` for a key to
   * restore that default; pass `null` for the whole argument to restore all.
   *
   * Defaults: play, pause, next, previous, seek, ±10s. Metadata / position are
   * still updated by the engine. Call this once after construct — it is not
   * wiped on `load()` / track change.
   */
  setMediaSessionActions(
    overrides: MediaSessionActionOverrides | null,
  ): this {
    if (overrides === null) {
      this.sessionOverrides = {};
    } else {
      this.sessionOverrides = { ...this.sessionOverrides, ...overrides };
      for (const key of Object.keys(
        this.sessionOverrides,
      ) as (keyof MediaSessionActions)[]) {
        if (this.sessionOverrides[key] == null) delete this.sessionOverrides[key];
      }
    }
    if (this.pool) this.bindMediaSession();
    return this;
  }

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof EngineEvents>(
    event: K,
    listener: EngineEvents[K],
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Tear down modes, Media Session, and the audio pool. Not reusable after. */
  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.unbindSession?.();
    this.unbindSession = null;
    this.teardownModes();
    this.pool?.destroy();
    this.pool = null;
    this._mode = null;
  }

  private bindMediaSession(): void {
    this.unbindSession?.();
    const o = this.sessionOverrides;
    this.unbindSession = bindMediaSessionActions({
      play: o.play ?? (() => this.play()),
      pause: o.pause ?? (() => this.pause()),
      previoustrack: o.previoustrack ?? (() => this.previous()),
      nexttrack: o.nexttrack ?? (() => this.next()),
      seekto:
        o.seekto ??
        ((d) => {
          if (typeof d.seekTime === "number") void this.seek(d.seekTime);
        }),
      seekbackward:
        o.seekbackward ??
        ((d) => {
          void this.seek(this.currentTime - (d.seekOffset ?? 10));
        }),
      seekforward:
        o.seekforward ??
        ((d) => {
          void this.seek(this.currentTime + (d.seekOffset ?? 10));
        }),
    });
  }

  private teardownModes(): void {
    this.discrete?.destroy();
    this.continuous?.destroy();
    this.discrete = null;
    this.continuous = null;
  }

  private ensurePool(): void {
    if (!this.pool) {
      if (typeof document === "undefined") {
        throw new Error("AudioEngine.mount() requires a browser environment");
      }
      this.mount();
    }
  }

  private ensureAdapter(): void {
    if (!this.adapter) {
      throw new Error("AudioEngine.setAdapter() must be called before load()");
    }
  }
}
