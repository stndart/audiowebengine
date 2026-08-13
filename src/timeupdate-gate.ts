export type TimeupdateSnapshot = {
  currentTime: number;
  duration: number;
};

/**
 * Deduplicates timeupdate snapshots so a paused / stalled clock does not
 * re-emit. Call {@link next} with `force` after seek / play / pause.
 */
export class TimeupdateGate {
  private last: TimeupdateSnapshot | null = null;

  reset(): void {
    this.last = null;
  }

  /**
   * Returns the snapshot to emit, or `null` if it matches the last emit
   * and `force` is false.
   */
  next(
    currentTime: number,
    duration: number,
    force = false,
  ): TimeupdateSnapshot | null {
    if (
      !force &&
      this.last !== null &&
      this.last.currentTime === currentTime &&
      this.last.duration === duration
    ) {
      return null;
    }
    this.last = { currentTime, duration };
    return this.last;
  }
}
