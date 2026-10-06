import { isAbortError, isExpiringSoon } from "../expiry.js";
import { EngineEventState } from "../event-state.js";
import { seekMedia } from "../media-position.js";
import type { EngineEmitter } from "../events.js";
import { HookTracker } from "../hooks.js";
import { updateMediaSessionPosition } from "../media-session.js";
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
  private operation = new AbortController();
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
  }

  get state(): ContinuousState {
    return {
      queueId: this.queueId,
      queueKey: this.queueKey,
      index: this.index,
      timeline: this.timeline,
      meta: this.currentMeta,
      playing: this.eventState.playing,
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
    const gen = this.beginOperation();
    this.wantsPlayback = opts?.autoplay !== false;
    this.stopCurrent();
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;

    this.queueKey = queueKey;
    let resolved;
    try {
      resolved = await this.adapter.resolveContinuous(queueKey, {
        intent: "play",
        signal: this.operation.signal,
      });
    } catch (error) {
      if (gen !== this.gen || this.destroyed || isAbortError(error)) return;
      throw error;
    }
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
      signal: this.operation.signal,
      onError: error => this.reportTransportError(error, this.pool.current),
      maxBufferSeconds: ahead,
    });
    if (gen !== this.gen || this.destroyed) {
      attached.destroy();
      return;
    }
    this.attached = attached;

    const entry = this.timeline[this.index];
    if (entry) {
      // Seek before polling/binding so loading a later item cannot announce
      // track zero while metadata is still loading.
      await this.seekToEntry(entry, 0);
      if (gen !== this.gen || this.destroyed) return;
      this.setIndex(findTimelineIndex(this.timeline, this.pool.current.currentTime));
    } else {
      this.currentMeta = undefined;
    }
    this.bindListeners();

    if (this.wantsPlayback) {
      await this.safePlay();
    }
  }

  async play(): Promise<void> {
    this.wantsPlayback = true;
    if (!this.attached || !this.currentMeta || this.destroyed) return;
    await this.safePlay();
  }

  pause(): void {
    this.wantsPlayback = false;
    this.stopCurrent();
  }

  /** Seek within the current logical track. */
  seek(time: number): void {
    if (!Number.isFinite(time) || !this.attached || this.destroyed) return;
    this.syncIndexFromClock();
    const entry = this.timeline[this.index];
    if (!entry) {
      this.pool.current.currentTime = Math.max(0, time);
      this.emitTimeClock(true);
      return;
    }
    const target = timelineSeekTime(entry, time);
    if (target === this.pool.current.currentTime) return;
    this.pool.current.currentTime = target;
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
    if (this.destroyed || !Number.isInteger(index)) return;
    const entry = this.timeline[index];
    if (!entry) return;
    this.wantsPlayback = true;
    this.syncIndexFromClock();
    if (this.attached && this.currentMeta && index === this.index && !this.pool.current.ended) {
      await this.play();
      return;
    }
    const gen = this.beginOperation();
    await this.seekToEntry(entry, 0);
    if (gen !== this.gen || this.destroyed) return;
    this.hookTracker.reset();
    this.setIndex(findTimelineIndex(this.timeline, this.pool.current.currentTime));
    this.emitTimeClock(true);
    await this.safePlay();
  }

  /**
   * Hot-swap m3u8 (e.g. remux cache_key change) while preserving absolute clock.
   */
  async replaceSource(url: string, preservePosition = true): Promise<void> {
    if (!this.attached || !this.currentMeta || this.destroyed) return;
    const abs = this.pool.current.currentTime;
    const wasPlaying = !this.pool.current.paused;
    const ahead = this.options.prefetch?.hlsAheadSeconds
      ? Math.max(30, this.options.prefetch.hlsAheadSeconds + 20)
      : 30;

    const gen = this.beginOperation();
    this.wantsPlayback = wasPlaying;
    this.stopCurrent();
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;
    const attached = await attachSource(
      this.pool.current,
      { kind: "hls", url },
      {
        ...(this.options.hls ?? {}),
        maxBufferSeconds: ahead,
        signal: this.operation.signal,
        onError: error => this.reportTransportError(error, this.pool.current),
      },
    );
    if (gen !== this.gen || this.destroyed) {
      attached.destroy();
      return;
    }
    this.attached = attached;
    // Restore the clock before playback can announce a track from offset zero.
    if (preservePosition) await this.seekToTime(abs);
    if (gen !== this.gen || this.destroyed) return;
    this.syncIndexFromClock();
    this.bindListeners();
    this.emitTimeClock(true);

    if (this.wantsPlayback) await this.safePlay();
  }

  destroy(): void {
    this.destroyed = true;
    this.gen += 1;
    this.operation.abort();
    this.teardownListeners();
    this.attached?.destroy();
    this.attached = null;
    this.stopTimeLoop();
  }

  private async seekToEntry(
    entry: TimelineEntry,
    offsetSec: number,
  ): Promise<void> {
    await this.seekToTime(timelineSeekTime(entry, offsetSec));
  }

  private async seekToTime(target: number): Promise<void> {
    await seekMedia(this.pool.current, target, this.operation.signal);
  }

  private beginOperation(): number {
    this.operation.abort();
    this.operation = new AbortController();
    return ++this.gen;
  }

  private stopCurrent(): void {
    this.pool.current.pause();
    if (this.eventState.setPlaying(false)) this.emitTimeClock(true);
  }

  private setIndex(index: number): void {
    const changed = index !== this.index || !this.currentMeta;
    this.index = index;
    const entry = this.timeline[index];
    this.currentMeta = entry ? timelineEntryToMeta(entry) : undefined;
    if (changed) {
      this.hookTracker.reset();
      this.timeGate.reset();
    }
    if (!this.currentMeta) return;
    this.emitTrackChange();
  }

  private emitTrackChange(): void {
    if (!this.currentMeta) return;
    this.eventState.select(JSON.stringify(["continuous", this.queueKey]), {
      track: this.currentMeta,
      index: this.index,
      queueId: this.queueId,
    });
  }

  private syncIndexFromClock(): void {
    const i = findTimelineIndex(this.timeline, this.pool.current.currentTime);
    if (i !== this.index) {
      this.setIndex(i);
    }
  }

  private bindListeners(): void {
    this.teardownListeners();
    const audio = this.pool.current;

    this.playHandler = () => {
      if (this.pool.isUnlocking || audio.paused) return;
      this.syncIndexFromClock();
      this.wantsPlayback = true;
      if (!this.eventState.setPlaying(true)) return;
      this.startTimeLoop();
      this.emitTimeClock(true);
    };
    this.pauseHandler = () => {
      if (this.pool.isUnlocking || !audio.paused) return;
      if (!this.eventState.setPlaying(false)) return;
      this.wantsPlayback = false;
      this.emitTimeClock(true);
    };
    this.endedHandler = () => {
      if (!audio.ended || this.destroyed || this.eventState.hasEnded) return;
      const gen = this.gen;
      this.emitTimeClock(true, true);
      if (gen !== this.gen || this.destroyed) return;
      this.eventState.end();
    };
    this.errorHandler = () => {
      if (!audio.error || this.destroyed) return;
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

  private emitTimeClock(force = false, terminal = false): void {
    if (this.destroyed || this.pool.isUnlocking || !this.currentMeta) return;
    const gen = this.gen;
    this.syncIndexFromClock();
    const snapshot = this.timeGate.next(this.currentTime, this.duration, force);
    if (!snapshot) return;
    this.emitter.emit("timeupdate", snapshot);
    if (gen !== this.gen || this.destroyed) return;
    if (terminal || (this.eventState.playing && !this.pool.current.paused && !this.pool.current.ended)) {
      this.hookTracker.tick(this.emitter, snapshot.currentTime, snapshot.duration,
        () => gen === this.gen && !this.destroyed);
    }
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

  private reportTransportError(error: unknown, audio: HTMLAudioElement): void {
    if (this.destroyed) return;
    if (audio === this.pool.current) {
      this.wantsPlayback = false;
      this.stopCurrent();
    }
    this.emitter.emit("error", { error });
  }

  private async safePlay(): Promise<void> {
    const gen = this.gen;
    const audio = this.pool.current;
    try {
      if (this.destroyed || !this.attached || !this.wantsPlayback) return;
      await this.pool.unlock();
      if (gen !== this.gen || this.destroyed || !this.attached || !this.wantsPlayback) return;
      await audio.play();
    } catch (e) {
      if (isAbortError(e) || gen !== this.gen || this.destroyed) return;
      this.emitter.emit("error", { error: e });
    }
  }
}
