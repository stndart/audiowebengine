import type { EngineEmitter } from "./events.js";
import type { HooksConfig } from "./types.js";

/**
 * Tracks per-track hook firings (beforeend once, progress thresholds once each).
 */
export class HookTracker {
  private beforeEndFired = false;
  private progressFired = new Set<number>();
  private beforeEndSeconds: number;
  private progressPercents: number[];

  constructor(hooks: HooksConfig = {}) {
    this.beforeEndSeconds = hooks.beforeEndSeconds ?? 5;
    this.progressPercents = [...(hooks.progressPercents ?? [])].sort(
      (a, b) => a - b,
    );
  }

  reset(): void {
    this.beforeEndFired = false;
    this.progressFired.clear();
  }

  configure(hooks: HooksConfig): void {
    if (hooks.beforeEndSeconds != null) {
      this.beforeEndSeconds = hooks.beforeEndSeconds;
    }
    if (hooks.progressPercents) {
      this.progressPercents = [...hooks.progressPercents].sort((a, b) => a - b);
    }
    this.reset();
  }

  tick(
    emitter: EngineEmitter,
    currentTime: number,
    duration: number,
    isCurrent: () => boolean = () => true,
  ): void {
    if (!Number.isFinite(duration) || duration <= 0) return;

    const remaining = duration - currentTime;
    if (
      !this.beforeEndFired &&
      remaining <= this.beforeEndSeconds &&
      remaining >= 0
    ) {
      this.beforeEndFired = true;
      emitter.emit("beforeend", {
        secondsRemaining: remaining,
        currentTime,
        duration,
      });
    }

    const pct = (currentTime / duration) * 100;
    for (const threshold of this.progressPercents) {
      if (!isCurrent()) return;
      if (!this.progressFired.has(threshold) && pct >= threshold) {
        this.progressFired.add(threshold);
        emitter.emit("progress", {
          percent: threshold,
          currentTime,
          duration,
        });
      }
    }
  }
}
