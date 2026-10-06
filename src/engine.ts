import { EngineEventState } from "./event-state.js";
import { isAbortError } from "./expiry.js";
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
  private readonly eventState: EngineEventState;
  private destroyed = false;
  private loadGeneration = 0;
  private readonly options: AudioEngineOptions;
  private pool: DualAudioPool | null = null;
  private adapter: SourceAdapter | null = null;
  private discrete: DiscreteQueueMode | null = null;
  private continuous: ContinuousHlsMode | null = null;
  private _mode: EngineMode | null = null;
  private sessionOverrides: MediaSessionActionOverrides = {};
  private unbindSession: (() => void) | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.emitter = createEngineEmitter();
    this.eventState = new EngineEventState(this.emitter);
  }

  get mode(): EngineMode | null {
    return this._mode;
  }

  get playing(): boolean {
    return this.eventState.playing;
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
    if (this.destroyed) throw new Error("AudioEngine has been destroyed");
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
    const generation = ++this.loadGeneration;
    this.discrete?.pause();
    this.continuous?.pause();
    this.teardownModes();
    // Priming saves/restores element positions. Let an existing cycle finish
    // before attaching a successor source that could otherwise be rewound.
    if (this.pool!.isUnlocking) await this.pool!.unlock();
    if (generation !== this.loadGeneration || this.destroyed) return;

    if (options.mode === "discrete") {
      this._mode = "discrete";
      this.discrete = new DiscreteQueueMode(
        this.pool!,
        this.emitter,
        this.adapter!,
        this.options,
        this.eventState,
      );
      const mode = this.discrete;
      await this.run(mode, () => mode.load(options.ids, options.startIndex ?? 0, {
        queueId: options.queueId,
        autoplay: options.autoplay,
      }));
      if (this.discrete === mode && !mode.state.meta) this.eventState.clear();
      return;
    }

    this._mode = "continuous";
    this.continuous = new ContinuousHlsMode(
      this.pool!,
      this.emitter,
      this.adapter!,
      this.options,
      this.eventState,
    );
    const mode = this.continuous;
    await this.run(mode, () => mode.load(options.queueKey, options.startIndex ?? 0, {
      autoplay: options.autoplay,
    }));
    if (this.continuous === mode && !mode.state.meta) this.eventState.clear();
  }

  /** Resume the current element. Unlocks the pool first. No-op if not loaded. */
  async play(): Promise<void> {
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, () => mode.play());
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
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, async () => mode.seek(time));
  }

  /** Next queue index. No wrap. Discrete `ended` also calls this. */
  async next(): Promise<void> {
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, () => mode.next());
  }

  /** Previous queue index. No wrap. No-op on the first item. */
  async previous(): Promise<void> {
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, () => mode.previous());
  }

  /**
   * Select a queue index and play, without a full {@link load}. Selecting
   * the current item resumes at its existing position. Prefer this when `queueId` is already loaded.
   */
  async playAt(index: number): Promise<void> {
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, () => mode instanceof DiscreteQueueMode
      ? mode.playIndex(index)
      : mode.playAt(index));
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
    const mode = this.discrete ?? this.continuous;
    if (mode) await this.run(mode, () => mode.replaceSource(opts.url, preserve));
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
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration += 1;
    this.unbindSession?.();
    this.unbindSession = null;
    this.teardownModes();
    this.pool?.destroy();
    this.pool = null;
    this._mode = null;
    this.emitter.events = {};
    this.eventState.setPlaying(false);
    this.eventState.clear();
  }

  private async run(mode: DiscreteQueueMode | ContinuousHlsMode, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (this.destroyed || isAbortError(error) ||
          (this.discrete !== mode && this.continuous !== mode)) return;
      this.emitter.emit("error", { error });
    }
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
    if (this.destroyed) throw new Error("AudioEngine has been destroyed");
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
