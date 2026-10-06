import { isAbortError, isExpiringSoon } from "../expiry.js";
import { EngineEventState } from "../event-state.js";
import { seekMedia } from "../media-position.js";
import type { EngineEmitter } from "../events.js";
import { HookTracker } from "../hooks.js";
import { updateMediaSessionPosition } from "../media-session.js";
import { DualAudioPool } from "../pool.js";
import {
  PrefetchController,
  progressivePreloadFor,
} from "../prefetch/progressive-range.js";
import {
  capHlsBuffer,
  resumeHlsPlayback,
} from "../prefetch/hls-buffer.js";
import { TimeupdateGate } from "../timeupdate-gate.js";
import { attachSource } from "../transports/attach.js";
import type {
  AttachedMedia,
  AudioEngineOptions,
  HlsTransportConfig,
  PrefetchConfig,
  ResolvedTrack,
  SourceAdapter,
  TrackMeta,
} from "../types.js";

export type DiscreteState = {
  ids: string[];
  index: number;
  queueId?: string;
  meta: TrackMeta | undefined;
  playing: boolean;
};

/**
 * Discrete per-track queue with dual-element warm slot.
 */
export class DiscreteQueueMode {
  private ids: string[] = [];
  private index = 0;
  private queueId: string | undefined;
  private currentAttached: AttachedMedia | null = null;
  private nextAttached: AttachedMedia | null = null;
  private nextResolved: ResolvedTrack | null = null;
  private currentMeta: TrackMeta | undefined;
  private unsubBeforeEnd: (() => void) | null = null;
  private hookTracker: HookTracker;
  private timeGate = new TimeupdateGate();
  private prefetchCtrl = new PrefetchController();
  private prefetchingId: string | null = null;
  private prefetchingGeneration: number | null = null;
  private timeTimer: ReturnType<typeof setInterval> | null = null;
  private listenerAudio: HTMLAudioElement | null = null;
  private endedHandler: (() => void) | null = null;
  private playHandler: (() => void) | null = null;
  private pauseHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;
  private destroyed = false;
  private wantsPlayback = false;

  constructor(
    private pool: DualAudioPool,
    private emitter: EngineEmitter,
    private adapter: SourceAdapter,
    private options: AudioEngineOptions,
    private eventState: EngineEventState,
  ) {
    this.hookTracker = new HookTracker(options.hooks);
    this.unsubBeforeEnd = this.emitter.on("beforeend", () => {
      if (!this.prefetchConfig().enabled) return;
      void this.prefetchNext();
    });
  }

  get state(): DiscreteState {
    return {
      ids: this.ids,
      index: this.index,
      queueId: this.queueId,
      meta: this.currentMeta,
      playing: this.eventState.playing,
    };
  }

  get currentTime(): number {
    return this.pool.current.currentTime;
  }

  get duration(): number {
    const d = this.pool.current.duration;
    return Number.isFinite(d) ? d : (this.currentMeta?.duration ?? 0);
  }

  async load(
    ids: string[],
    startIndex = 0,
    opts?: { queueId?: string; autoplay?: boolean },
  ): Promise<void> {
    this.stopCurrent();
    this.teardownMediaListeners();
    this.destroyAttached();
    this.ids = ids.slice();
    this.index = Math.max(0, Math.min(startIndex, Math.max(0, ids.length - 1)));
    this.queueId = opts?.queueId;
    this.hookTracker.reset();
    this.prefetchCtrl.bump();

    if (!ids.length) {
      this.currentMeta = undefined;
      return;
    }

    await this.playIndex(this.index, { autoplay: opts?.autoplay ?? true });
  }

  async playIndex(
    index: number,
    opts?: { autoplay?: boolean },
  ): Promise<void> {
    if (this.destroyed || !Number.isInteger(index) || index < 0 || index >= this.ids.length) return;
    this.wantsPlayback = opts?.autoplay !== false;
    if (this.currentAttached && index === this.index && !this.pool.current.ended) {
      if (this.wantsPlayback) await this.play();
      return;
    }
    const gen = this.prefetchCtrl.bump();
    this.stopCurrent();
    this.teardownMediaListeners();

    const warm = this.nextResolved;
    const canPromote =
      warm &&
      warm.meta.id === this.ids[index] &&
      this.nextAttached &&
      !isExpiringSoon(warm.source.expiresAt);

    if (canPromote) {
      this.pool.current.pause();
      this.currentAttached?.destroy();
      this.pool.swap();
      const promoted = this.nextAttached!;
      this.currentAttached = promoted;
      this.nextAttached = null;
      const resolved = this.nextResolved!;
      this.nextResolved = null;
      this.index = index;
      this.currentMeta = resolved.meta;
      if (resolved.source.kind === "hls") {
        resumeHlsPlayback(
          promoted,
          this.options.prefetch?.hlsAheadSeconds
            ? Math.max(30, this.options.prefetch.hlsAheadSeconds)
            : 30,
        );
      } else {
        this.pool.current.preload = "auto";
      }
      this.bindCurrentListeners();
      this.onTrackSelected();
      if (this.wantsPlayback) {
        await this.safePlay(this.pool.current);
      }
      return;
    }

    this.destroyAttached();
    const id = this.ids[index]!;
    let resolved: ResolvedTrack;
    try {
      resolved = await this.adapter.resolve(id, {
        signal: this.prefetchCtrl.signal,
        intent: "play",
      });
    } catch (error) {
      if (this.stale(gen) || isAbortError(error)) return;
      throw error;
    }
    if (this.stale(gen)) return;

    const audio = this.pool.current;
    const attached = await attachSource(
      audio,
      resolved.source,
      {
        ...this.hlsOpts(),
        preload: progressivePreloadFor("play"),
        signal: this.prefetchCtrl.signal,
        onError: error => this.reportTransportError(error, audio),
      },
    );
    if (this.stale(gen)) {
      attached.destroy();
      return;
    }

    this.index = index;
    this.currentMeta = resolved.meta;
    this.currentAttached = attached;
    this.bindCurrentListeners();
    this.onTrackSelected();
    if (this.wantsPlayback) {
      await this.safePlay(this.pool.current);
    }
  }

  async play(): Promise<void> {
    this.wantsPlayback = true;
    if (!this.currentAttached || this.destroyed) return;
    await this.safePlay(this.pool.current);
  }

  pause(): void {
    this.wantsPlayback = false;
    this.stopCurrent();
  }

  seek(time: number): void {
    if (!Number.isFinite(time) || !this.currentAttached || this.destroyed) return;
    const target = Math.max(0, time);
    if (target === this.pool.current.currentTime) return;
    this.pool.current.currentTime = target;
    this.hookTracker.reset();
    this.emitTimeClock(true);
  }

  async next(): Promise<void> {
    if (this.index >= this.ids.length - 1) return;
    await this.playIndex(this.index + 1);
  }

  async previous(): Promise<void> {
    if (this.index <= 0) return;
    await this.playIndex(this.index - 1);
  }

  async prefetchNext(): Promise<void> {
    const cfg = this.prefetchConfig();
    if (!cfg.enabled || this.destroyed || !this.currentAttached) return;
    const index = this.index + 1;
    if (index >= this.ids.length) return;

    const id = this.ids[index]!;
    if (this.nextResolved?.meta.id === id && this.nextAttached) return;
    if (this.prefetchingId === id && this.prefetchingGeneration === this.prefetchCtrl.generation) return;

    const gen = this.prefetchCtrl.generation;
    this.prefetchingId = id;
    this.prefetchingGeneration = gen;
    try {
      const resolved = await this.adapter.resolve(id, {
        signal: this.prefetchCtrl.signal,
        intent: "prefetch-next",
      });
      if (this.stale(gen)) return;
      if (isExpiringSoon(resolved.source.expiresAt)) return;

      const audio = this.pool.next;
      if (resolved.source.kind === "progressive") {
        this.pool.next.pause();
        this.nextAttached?.destroy();
        const attached = await attachSource(
          audio,
          resolved.source,
          {
            ...this.hlsOpts(),
            signal: this.prefetchCtrl.signal,
            onError: error => this.reportTransportError(error, audio),
            preload: progressivePreloadFor("prefetch-next"),
          },
        );
        if (this.stale(gen)) {
          attached.destroy();
          return;
        }
        this.nextAttached = attached;
        this.nextResolved = resolved;
        return;
      }

      this.nextAttached?.destroy();
      const ahead = cfg.hlsAheadSeconds ?? 15;
      const attached = await attachSource(audio, resolved.source, {
        ...this.hlsOpts(),
        signal: this.prefetchCtrl.signal,
        onError: error => this.reportTransportError(error, audio),
        maxBufferSeconds: ahead,
        autoStartLoad: true,
        pauseAfterBufferedSeconds: ahead,
      });
      if (this.stale(gen)) {
        attached.destroy();
        return;
      }
      capHlsBuffer(attached, ahead);
      this.nextAttached = attached;
      this.nextResolved = resolved;
    } catch (error) {
      if (isAbortError(error) || this.stale(gen)) return;
      this.emitter.emit("error", { error });
    } finally {
      if (this.prefetchingId === id && this.prefetchingGeneration === gen) {
        this.prefetchingId = null;
        this.prefetchingGeneration = null;
      }
    }
  }

  async replaceSource(url: string, preservePosition = true): Promise<void> {
    const pos = this.pool.current.currentTime;
    const wasPlaying = !this.pool.current.paused;
    const meta = this.currentMeta;
    if (!meta || this.destroyed || !this.currentAttached) return;
    const gen = this.prefetchCtrl.bump();
    this.wantsPlayback = wasPlaying;

    const kind =
      this.currentAttached && url.includes(".m3u8")
        ? ("hls" as const)
        : ("progressive" as const);

    this.stopCurrent();
    this.teardownMediaListeners();
    this.currentAttached?.destroy();
    this.currentAttached = null;
    const audio = this.pool.current;
    const attached = await attachSource(
      audio,
      kind === "hls"
        ? { kind: "hls", url }
        : { kind: "progressive", url },
      {
        ...this.hlsOpts(),
        preload: "auto",
        signal: this.prefetchCtrl.signal,
        onError: error => this.reportTransportError(error, audio),
      },
    );
    if (this.stale(gen)) {
      attached.destroy();
      return;
    }
    this.currentAttached = attached;
    if (preservePosition) await seekMedia(this.pool.current, pos, this.prefetchCtrl.signal!);
    if (this.stale(gen)) return;
    this.bindCurrentListeners();
    this.emitTimeClock(true);
    if (this.wantsPlayback) await this.safePlay(this.pool.current);
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubBeforeEnd?.();
    this.unsubBeforeEnd = null;
    this.teardownMediaListeners();
    this.destroyAttached();
    this.prefetchCtrl.destroy();
    this.stopTimeLoop();
  }

  private stale(gen: number): boolean {
    return gen !== this.prefetchCtrl.generation || this.destroyed;
  }

  private bindCurrentListeners(): void {
    this.teardownMediaListeners();
    const audio = this.pool.current;
    this.listenerAudio = audio;

    this.playHandler = () => {
      if (this.pool.isUnlocking || audio.paused || audio !== this.pool.current) return;
      this.wantsPlayback = true;
      if (!this.eventState.setPlaying(true)) return;
      this.startTimeLoop();
      this.emitTimeClock(true);
    };
    this.pauseHandler = () => {
      if (this.pool.isUnlocking || !audio.paused || audio !== this.pool.current) return;
      if (!this.eventState.setPlaying(false)) return;
      this.wantsPlayback = false;
      this.emitTimeClock(true);
    };
    this.endedHandler = () => {
      if (!audio.ended || this.destroyed || audio !== this.pool.current || this.eventState.hasEnded) return;
      const gen = this.prefetchCtrl.generation;
      this.emitTimeClock(true, true);
      if (this.stale(gen)) return;
      if (!this.eventState.end()) return;
      void this.next().catch(error => {
        if (!this.destroyed && !isAbortError(error)) this.emitter.emit("error", { error });
      });
    };
    this.errorHandler = () => {
      if (!audio.error || this.destroyed || audio !== this.pool.current) return;
      this.wantsPlayback = false;
      this.eventState.setPlaying(false);
      this.emitter.emit("error", {
        error: audio.error ?? new Error("media error"),
      });
    };

    audio.addEventListener("play", this.playHandler);
    audio.addEventListener("pause", this.pauseHandler);
    audio.addEventListener("ended", this.endedHandler);
    audio.addEventListener("error", this.errorHandler);
    this.startTimeLoop();
  }

  private teardownMediaListeners(): void {
    const audio = this.listenerAudio;
    if (this.playHandler) audio?.removeEventListener("play", this.playHandler);
    if (this.pauseHandler) audio?.removeEventListener("pause", this.pauseHandler);
    if (this.endedHandler) audio?.removeEventListener("ended", this.endedHandler);
    if (this.errorHandler) audio?.removeEventListener("error", this.errorHandler);
    this.playHandler = null;
    this.pauseHandler = null;
    this.endedHandler = null;
    this.errorHandler = null;
    this.listenerAudio = null;
    this.stopTimeLoop();
  }

  private startTimeLoop(): void {
    this.stopTimeLoop();
    const interval = this.options.timeupdateIntervalMs ?? 250;
    this.timeTimer = setInterval(() => this.emitTimeClock(), interval);
  }

  private stopTimeLoop(): void {
    if (this.timeTimer != null) {
      clearInterval(this.timeTimer);
      this.timeTimer = null;
    }
    this.timeGate.reset();
  }

  private emitTimeClock(force = false, terminal = false): void {
    if (this.destroyed || this.pool.isUnlocking || !this.currentMeta) return;
    const gen = this.prefetchCtrl.generation;
    const currentTime = this.pool.current.currentTime;
    const duration = this.duration;
    const snapshot = this.timeGate.next(currentTime, duration, force);
    if (!snapshot) return;
    this.emitter.emit("timeupdate", snapshot);
    if (this.stale(gen)) return;
    if (terminal || (this.eventState.playing && !this.pool.current.paused && !this.pool.current.ended)) {
      this.hookTracker.tick(this.emitter, snapshot.currentTime, snapshot.duration, () => !this.stale(gen));
    }
    updateMediaSessionPosition({
      duration: snapshot.duration,
      position: snapshot.currentTime,
    });
  }

  /**
   * Announce the selected track, even while paused, and reset per-track hooks.
   */
  private onTrackSelected(): void {
    if (!this.currentMeta) return;
    this.hookTracker.reset();
    this.timeGate.reset();
    this.emitTrackChange();
  }

  private emitTrackChange(): void {
    if (!this.currentMeta) return;
    const context = JSON.stringify(["discrete", this.queueId ?? this.ids]);
    this.eventState.select(context, {
      track: this.currentMeta,
      index: this.index,
      queueId: this.queueId,
    });
  }

  private stopCurrent(): void {
    this.pool.current.pause();
    if (this.eventState.setPlaying(false)) this.emitTimeClock(true);
  }

  private destroyAttached(): void {
    this.currentAttached?.destroy();
    this.nextAttached?.destroy();
    this.currentAttached = null;
    this.nextAttached = null;
    this.nextResolved = null;
    this.prefetchingId = null;
    this.prefetchingGeneration = null;
  }

  private prefetchConfig(): PrefetchConfig {
    return this.options.prefetch ?? {};
  }

  private hlsOpts(): HlsTransportConfig {
    return this.options.hls ?? {};
  }

  private reportTransportError(error: unknown, audio: HTMLAudioElement): void {
    if (this.destroyed) return;
    if (audio === this.pool.current) {
      this.wantsPlayback = false;
      this.stopCurrent();
    }
    this.emitter.emit("error", { error });
  }

  private async safePlay(el: HTMLAudioElement): Promise<void> {
    const gen = this.prefetchCtrl.generation;
    try {
      if (this.stale(gen) || !this.currentAttached || !this.wantsPlayback) return;
      await this.pool.unlock();
      if (this.stale(gen) || el !== this.pool.current || !this.currentAttached || !this.wantsPlayback) return;
      await el.play();
    } catch (e) {
      if (isAbortError(e) || this.stale(gen)) return;
      this.emitter.emit("error", { error: e });
    }
  }
}
