import { isAbortError, isExpiringSoon } from "../expiry.js";
import type { EngineEmitter } from "../events.js";
import { HookTracker } from "../hooks.js";
import {
  setMediaSessionPlaybackState,
  updateMediaSessionMetadata,
  updateMediaSessionPosition,
} from "../media-session.js";
import { DualAudioPool } from "../pool.js";
import {
  buildTimeline,
  findTimelineIndex,
  timelineEntryToMeta,
  timelineSeekTime,
  type TimelineEntry,
} from "../timeline.js";
import { TimeupdateGate } from "../timeupdate-gate.js";
import { attachSource } from "../transports/attach.js";
import type {
  AttachedMedia,
  AudioEngineOptions,
  SourceAdapter,
  TrackMeta,
} from "../types.js";

export type ContinuousState = {
  queueId?: string;
  queueKey: string;
  index: number;
  timeline: TimelineEntry[];
  meta: TrackMeta | undefined;
  playing: boolean;
};

/**
 * Continuous queue HLS with virtual track timeline (webplayer model).
 */
export class ContinuousHlsMode {
  private queueKey = "";
  private queueId: string | undefined;
  private timeline: TimelineEntry[] = [];
  private index = 0;
  private attached: AttachedMedia | null = null;
  private currentMeta: TrackMeta | undefined;
  private hookTracker: HookTracker;
  private timeGate = new TimeupdateGate();
  private timeTimer: ReturnType<typeof setInterval> | null = null;
  private playHandler: (() => void) | null = null;
  private pauseHandler: (() => void) | null = null;
  private endedHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;
  private gen = 0;
  private destroyed = false;

  constructor(
    private pool: DualAudioPool,
    private emitter: EngineEmitter,
    private adapter: SourceAdapter,
    private options: AudioEngineOptions,
  ) {
    this.hookTracker = new HookTracker(options.hooks);
  }

  get state(): ContinuousState {
    return {
      queueId: this.queueId,
      queueKey: this.queueKey,
      index: this.index,
      timeline: this.timeline,
      meta: this.currentMeta,
      playing: !this.pool.current.paused && !this.pool.current.ended,
    };
  }

  /** Position within the current logical track. */
  get currentTime(): number {
    const entry = this.timeline[this.index];
    if (!entry) return this.pool.current.currentTime;
    return Math.max(0, this.pool.current.currentTime - entry.start);
  }

  get duration(): number {
    const entry = this.timeline[this.index];
    return entry?.duration ?? 0;
  }

  /** Absolute media clock. */
  get absoluteTime(): number {
    return this.pool.current.currentTime;
  }

  async load(
    queueKey: string,
    startIndex = 0,
    opts?: { autoplay?: boolean },
  ): Promise<void> {
    if (!this.adapter.resolveContinuous) {
      throw new Error("SourceAdapter.resolveContinuous is required for continuous mode");
    }
    const gen = ++this.gen;
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;

    this.queueKey = queueKey;
    const resolved = await this.adapter.resolveContinuous(queueKey, {
      intent: "play",
    });
    if (gen !== this.gen || this.destroyed) return;
    if (isExpiringSoon(resolved.source.expiresAt)) {
      this.emitter.emit("error", {
        error: new Error("continuous HLS URL is expired or about to expire"),
      });
      return;
    }

    this.queueId = resolved.queueId ?? queueKey;
    this.timeline = buildTimeline(resolved.timeline);
    this.index = Math.max(
      0,
      Math.min(startIndex, Math.max(0, this.timeline.length - 1)),
    );

    const ahead = this.options.prefetch?.enabled
      ? Math.max(30, (this.options.prefetch.hlsAheadSeconds ?? 15) + 20)
      : 30;

    const attached = await attachSource(this.pool.current, resolved.source, {
      ...(this.options.hls ?? {}),
      maxBufferSeconds: ahead,
    });
    if (gen !== this.gen || this.destroyed) {
      attached.destroy();
      return;
    }
    this.attached = attached;

    this.bindListeners();

    const entry = this.timeline[this.index];
    if (entry) {
      await this.seekToEntry(entry, 0);
      this.setIndex(this.index, true);
    }

    if (opts?.autoplay !== false) {
      await this.safePlay();
    }
  }

  async play(): Promise<void> {
    await this.pool.unlock();
    await this.safePlay();
  }

  pause(): void {
    this.pool.current.pause();
  }

  /** Seek within the current logical track. */
  seek(time: number): void {
    const entry = this.timeline[this.index];
    if (!entry) {
      this.pool.current.currentTime = Math.max(0, time);
      this.emitTimeClock(true);
      return;
    }
    this.pool.current.currentTime = timelineSeekTime(entry, time);
    this.hookTracker.reset();
    this.emitTimeClock(true);
  }

  async next(): Promise<void> {
    if (this.index >= this.timeline.length - 1) return;
    await this.playAt(this.index + 1);
  }

  async previous(): Promise<void> {
    if (this.index <= 0) return;
    await this.playAt(this.index - 1);
  }

  async playAt(index: number): Promise<void> {
    const entry = this.timeline[index];
    if (!entry) return;
    this.index = index;
    await this.seekToEntry(entry, 0);
    this.setIndex(index, true);
    await this.safePlay();
  }

  /**
   * Hot-swap m3u8 (e.g. remux cache_key change) while preserving absolute clock.
   */
  async replaceSource(url: string, preservePosition = true): Promise<void> {
    const abs = this.pool.current.currentTime;
    const wasPlaying = !this.pool.current.paused;
    const ahead = this.options.prefetch?.hlsAheadSeconds
      ? Math.max(30, this.options.prefetch.hlsAheadSeconds + 20)
      : 30;

    const gen = ++this.gen;
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;
    const attached = await attachSource(
      this.pool.current,
      { kind: "hls", url },
      { ...(this.options.hls ?? {}), maxBufferSeconds: ahead },
    );
    if (gen !== this.gen || this.destroyed) {
      attached.destroy();
      return;
    }
    this.attached = attached;
    this.bindListeners();

    if (preservePosition) {
      const onMeta = () => {
        this.pool.current.currentTime = abs;
        this.pool.current.removeEventListener("loadedmetadata", onMeta);
        this.syncIndexFromClock(true);
        this.emitTimeClock(true);
      };
      this.pool.current.addEventListener("loadedmetadata", onMeta);
    }

    if (wasPlaying) await this.safePlay();
  }

  destroy(): void {
    this.destroyed = true;
    this.gen += 1;
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;
    this.stopTimeLoop();
  }

  private async seekToEntry(
    entry: TimelineEntry,
    offsetSec: number,
  ): Promise<void> {
    const target = timelineSeekTime(entry, offsetSec);
    if (this.pool.current.readyState >= 1) {
      this.pool.current.currentTime = target;
      this.emitTimeClock(true);
      return;
    }
    await new Promise<void>((resolve) => {
      const onMeta = () => {
        this.pool.current.currentTime = target;
        this.pool.current.removeEventListener("loadedmetadata", onMeta);
        this.emitTimeClock(true);
        resolve();
      };
      this.pool.current.addEventListener("loadedmetadata", onMeta);
      // Safety timeout
      setTimeout(() => {
        this.pool.current.removeEventListener("loadedmetadata", onMeta);
        try {
          this.pool.current.currentTime = target;
        } catch {
          /* ignore */
        }
        this.emitTimeClock(true);
        resolve();
      }, 4000);
    });
  }

  private setIndex(index: number, emit: boolean): void {
    this.index = index;
    const entry = this.timeline[index];
    this.currentMeta = entry ? timelineEntryToMeta(entry) : undefined;
    this.hookTracker.reset();
    this.timeGate.reset();
    if (emit && this.currentMeta) {
      updateMediaSessionMetadata(this.currentMeta);
      this.emitter.emit("trackchange", {
        track: this.currentMeta,
        index,
        queueId: this.queueId,
      });
    }
  }

  private syncIndexFromClock(emit: boolean): void {
    const i = findTimelineIndex(this.timeline, this.pool.current.currentTime);
    if (i !== this.index) {
      this.setIndex(i, emit);
    }
  }

  private bindListeners(): void {
    this.teardownListeners();
    const audio = this.pool.current;

    this.playHandler = () => {
      setMediaSessionPlaybackState("playing");
      this.emitter.emit("play");
      this.startTimeLoop();
      this.emitTimeClock(true);
    };
    this.pauseHandler = () => {
      setMediaSessionPlaybackState("paused");
      this.emitter.emit("pause");
      this.emitTimeClock(true);
    };
    this.endedHandler = () => {
      this.emitter.emit("ended");
    };
    this.errorHandler = () => {
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

  private teardownListeners(): void {
    const audio = this.pool.current;
    if (this.playHandler) audio.removeEventListener("play", this.playHandler);
    if (this.pauseHandler) audio.removeEventListener("pause", this.pauseHandler);
    if (this.endedHandler) audio.removeEventListener("ended", this.endedHandler);
    if (this.errorHandler) audio.removeEventListener("error", this.errorHandler);
    this.playHandler = null;
    this.pauseHandler = null;
    this.endedHandler = null;
    this.errorHandler = null;
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

  private emitTimeClock(force = false): void {
    if (this.destroyed) return;
    this.syncIndexFromClock(true);
    const snapshot = this.timeGate.next(this.currentTime, this.duration, force);
    if (!snapshot) return;
    this.emitter.emit("timeupdate", snapshot);
    this.hookTracker.tick(
      this.emitter,
      snapshot.currentTime,
      snapshot.duration,
    );
    updateMediaSessionPosition({
      duration: snapshot.duration,
      position: snapshot.currentTime,
    });

    if (this.options.prefetch?.enabled && this.attached?.setMaxBufferSeconds) {
      const remaining = snapshot.duration - snapshot.currentTime;
      const ahead = this.options.prefetch.hlsAheadSeconds ?? 15;
      if (remaining <= (this.options.hooks?.beforeEndSeconds ?? 5) + ahead) {
        this.attached.setMaxBufferSeconds(Math.max(remaining + ahead, ahead));
      }
    }
  }

  private async safePlay(): Promise<void> {
    try {
      await this.pool.unlock();
      await this.pool.current.play();
    } catch (e) {
      if (isAbortError(e)) return;
      this.emitter.emit("error", { error: e });
    }
  }
}
