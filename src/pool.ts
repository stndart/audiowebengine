/**
 * Two HTMLAudioElements: current + next (warm).
 * Unlock both after the first user gesture so iOS allows later autoplay swaps.
 */
export class DualAudioPool {
  private _current: HTMLAudioElement;
  private _next: HTMLAudioElement;
  private unlocked = false;
  private unlockTask: Promise<void> | null = null;
  private unlocking = false;
  private owned = false;

  constructor(opts?: {
    current?: HTMLAudioElement;
    next?: HTMLAudioElement;
    container?: HTMLElement | Document;
    /** Default `use-credentials` so signed/cookie media can decode. */
    crossOrigin?: "anonymous" | "use-credentials" | null;
  }) {
    const crossOrigin =
      opts && "crossOrigin" in opts
        ? opts.crossOrigin
        : "use-credentials";

    if (opts?.current && opts?.next) {
      this._current = opts.current;
      this._next = opts.next;
    } else {
      this.owned = true;
      this._current = document.createElement("audio");
      this._next = document.createElement("audio");
      this._current.setAttribute("playsinline", "");
      this._next.setAttribute("playsinline", "");
      this._current.preload = "none";
      this._next.preload = "none";
      const parent =
        opts?.container instanceof Document
          ? opts.container.body
          : (opts?.container ??
            (typeof document !== "undefined" ? document.body : null));
      if (parent) {
        this._current.hidden = true;
        this._next.hidden = true;
        parent.appendChild(this._current);
        parent.appendChild(this._next);
      }
    }

    if (crossOrigin) {
      this._current.crossOrigin = crossOrigin;
      this._next.crossOrigin = crossOrigin;
    }
  }

  get current(): HTMLAudioElement {
    return this._current;
  }

  get next(): HTMLAudioElement {
    return this._next;
  }

  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** True only during the pool's internal muted play/pause cycle. */
  get isUnlocking(): boolean {
    return this.unlocking;
  }

  /**
   * Gesture-time autoplay unlock for both pool elements (iOS/Safari).
   * Muted play → pause, preserving mute and position. Prefer calling before
   * attaching a real `src`.
   * See `AudioEngine.unlock` / docs/api.md.
   */
  async unlock(): Promise<void> {
    if (this.unlockTask) return this.unlockTask;
    this.unlocked = true;
    this.unlocking = true;
    const silent = async (el: HTMLAudioElement) => {
      // Never interrupt playback if a host started the element itself.
      if (!el.paused) return;
      const muted = el.muted;
      const position = el.currentTime;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        el.muted = true;
        // Empty src: Chrome's play() promise may never settle. Don't block
        // unlock / later attach on that.
        await Promise.race([
          el.play(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 120);
          }),
        ]);
      } catch {
        /* ignore — first real play() will still be gesture-driven */
      } finally {
        clearTimeout(timeout);
        try {
          el.pause();
          if (el.src) el.currentTime = position;
        } catch {
          /* ignore */
        }
        el.muted = muted;
      }
    };
    this.unlockTask = Promise.all([silent(this._current), silent(this._next)])
      .then(() => {})
      .finally(() => {
        this.unlocking = false;
      });
    return this.unlockTask;
  }

  /** Promote next → current; old current becomes the warm slot. */
  swap(): void {
    const tmp = this._current;
    this._current = this._next;
    this._next = tmp;
    this._next.preload = "none";
  }

  destroy(): void {
    for (const el of [this._current, this._next]) {
      el.pause();
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* ignore */
      }
      if (this.owned && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }
  }
}
