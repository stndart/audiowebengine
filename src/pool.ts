/**
 * Two HTMLAudioElements: current + next (warm).
 * Unlock both after the first user gesture so iOS allows later autoplay swaps.
 */
export class DualAudioPool {
  private _current: HTMLAudioElement;
  private _next: HTMLAudioElement;
  private unlocked = false;
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

  /**
   * Gesture-time autoplay unlock for both pool elements (iOS/Safari).
   * Muted play → pause → rewind. Call before attaching a real `src`.
   * See `AudioEngine.unlock` / docs/api.md.
   */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;
    const silent = async (el: HTMLAudioElement) => {
      try {
        el.muted = true;
        // Empty src: Chrome's play() promise may never settle. Don't block
        // unlock / later attach on that.
        await Promise.race([
          el.play(),
          new Promise<void>((resolve) => setTimeout(resolve, 120)),
        ]);
      } catch {
        /* ignore — first real play() will still be gesture-driven */
      } finally {
        try {
          el.pause();
          if (el.src) el.currentTime = 0;
        } catch {
          /* ignore */
        }
        el.muted = false;
      }
    };
    await Promise.all([silent(this._current), silent(this._next)]);
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
