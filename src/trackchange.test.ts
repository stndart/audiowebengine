import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEngine } from "./engine.js";
import type { SourceAdapter, TrackChangePayload } from "./types.js";

// Exercise the engine, pool and modes together; only the browser transport is mocked.
vi.mock("./transports/attach.js", () => ({
  attachSource: vi.fn(async (audio: HTMLAudioElement, source: { url: string }) => {
    audio.pause();
    audio.src = source.url;
    audio.currentTime = 0;
    audio.load();
    setTimeout(() => audio.dispatchEvent(new Event("loadedmetadata")), 0);
    return {
      destroy() {
        audio.pause();
        audio.removeAttribute("src");
        audio.currentTime = 0;
      },
    };
  }),
}));

class TestAudio extends EventTarget {
  paused = true;
  ended = false;
  muted = false;
  currentTime = 0;
  duration = 10;
  readyState = 1;
  src = "";
  preload = "none";
  error = null;
  playError: Error | null = null;

  async play() {
    if (this.playError) throw this.playError;
    if (!this.paused) return;
    this.paused = false;
    // Native media events are queued rather than dispatched inline by play().
    await Promise.resolve();
    this.dispatchEvent(new Event("play"));
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    queueMicrotask(() => this.dispatchEvent(new Event("pause")));
  }

  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }

  load() {
    this.ended = false;
  }
}

const adapter: SourceAdapter = {
  async resolve(id) {
    return {
      meta: { id, title: id, duration: 10 },
      source: { kind: "progressive", url: `${id}.mp3` },
    };
  },
  async resolveContinuous(queueId) {
    return {
      queueId,
      source: { kind: "hls", url: "queue.m3u8" },
      timeline: ["a", "b", "c"].map(id => ({ id, title: id, duration: 10 })),
    };
  },
};

const engines: AudioEngine[] = [];
afterEach(() => {
  engines.splice(0).forEach(engine => engine.destroy());
  vi.useRealTimers();
});

function fixture(mode: "discrete" | "continuous") {
  vi.useFakeTimers();
  const current = new TestAudio();
  const next = new TestAudio();
  const engine = new AudioEngine({ prefetch: { enabled: true } });
  engine.mount({
    current: current as unknown as HTMLAudioElement,
    next: next as unknown as HTMLAudioElement,
  }).setAdapter(adapter);
  engines.push(engine);
  const changes: TrackChangePayload[] = [];
  const plays = vi.fn();
  const pauses = vi.fn();
  engine.on("trackchange", change => {
    // Every emitted payload must agree with the public engine snapshot.
    expect(change.track).toEqual(engine.currentMeta);
    expect(change.index).toBe(engine.currentIndex);
    expect(change.queueId).toBe(engine.queueId);
    changes.push(change);
  });
  engine.on("play", plays);
  engine.on("pause", pauses);
  const load = (autoplay = false, startIndex = 0) => engine.load(mode === "discrete"
    ? { mode, ids: ["a", "b", "c"], queueId: "q", autoplay, startIndex }
    : { mode, queueKey: "q", autoplay, startIndex });
  const ids = () => changes.map(change => change.track.id);
  return { engine, current, next, changes, plays, pauses, load, ids };
}

describe.each(["discrete", "continuous"] as const)("%s trackchange", mode => {
  it("announces a paused load with its queue identity", async () => {
    const { engine, changes, load } = fixture(mode);
    await load(false, 1);
    expect(engine.playing).toBe(false);
    expect(changes).toEqual([{
      track: expect.objectContaining({ id: "b" }), index: 1, queueId: "q",
    }]);
  });

  it("announces an autoplay selection once and announces later resume", async () => {
    const { engine, ids, plays, pauses, load } = fixture(mode);
    await load(true);
    expect(ids()).toEqual(["a"]);
    expect(plays).toHaveBeenCalledTimes(1);
    expect(pauses).not.toHaveBeenCalled();
    await engine.pause();
    await engine.play();
    expect(ids()).toEqual(["a", "a"]);
    expect(plays).toHaveBeenCalledTimes(2);
    expect(pauses).toHaveBeenCalledTimes(1);
  });

  it("includes muted playback and preserves the host's mute setting", async () => {
    const { engine, current, ids, load } = fixture(mode);
    current.muted = true;
    await load(true);
    expect(engine.playing).toBe(true);
    expect(current.muted).toBe(true);
    expect(ids()).toEqual(["a"]);
  });

  it("does not report an explicit unlock as playback or change the selected position", async () => {
    const { engine, current, ids, plays, pauses, load } = fixture(mode);
    await load(false, 1);
    const position = current.currentTime;
    await engine.unlock();
    expect(current.currentTime).toBe(position);
    expect(ids()).toEqual(["b"]);
    expect(plays).not.toHaveBeenCalled();
    expect(pauses).not.toHaveBeenCalled();
  });

  it("reports next/previous while paused and playing", async () => {
    const { engine, ids, load } = fixture(mode);
    await load();
    await engine.next();
    expect(ids()).toEqual(["a", "b"]);
    await engine.previous();
    expect(ids()).toEqual(["a", "b", "a"]);
    expect(engine.currentIndex).toBe(0);
  });

  it("does not duplicate a paused selection on its first play", async () => {
    const { engine, ids, plays, load } = fixture(mode);
    await load();
    expect(ids()).toEqual(["a"]);
    await engine.play();
    expect(ids()).toEqual(["a"]);
    expect(plays).toHaveBeenCalledTimes(1);
    await engine.pause();
    await engine.play();
    expect(ids()).toEqual(["a", "a"]);
  });

  it("keeps per-track hooks intact on resume", async () => {
    const { engine, current, load } = fixture(mode);
    const beforeend = vi.fn();
    engine.on("beforeend", beforeend);
    await load(true);
    current.currentTime = 6;
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeend).toHaveBeenCalledTimes(1);
    await engine.pause();
    await engine.play();
    expect(beforeend).toHaveBeenCalledTimes(1);
  });

  it("announces the selected track even if autoplay is rejected", async () => {
    const { engine, current, ids, plays, load } = fixture(mode);
    const errors = vi.fn();
    engine.on("error", errors);
    current.playError = new Error("autoplay blocked");
    await load(true);
    expect(ids()).toEqual(["a"]);
    expect(plays).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

it("continuous resume synchronizes the media clock before announcing", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load();
  await engine.unlock();
  changes.length = 0;
  current.currentTime = 11;
  await engine.play();
  expect(ids()).toEqual(["b"]);
});

it("continuous boundaries and paused seeks emit exactly one changed track", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true);
  changes.length = 0;
  current.currentTime = 11;
  await vi.advanceTimersByTimeAsync(250);
  expect(ids()).toEqual(["b"]);
  await vi.advanceTimersByTimeAsync(500);
  expect(ids()).toEqual(["b"]);
  await engine.pause();
  await engine.seek(15);
  expect(ids()).toEqual(["b"]); // Logical seek is clamped to the current track.
  current.currentTime = 21; // A host/native seek uses the absolute clock.
  await vi.advanceTimersByTimeAsync(250);
  expect(ids()).toEqual(["b", "c"]);
  await engine.play();
  expect(ids()).toEqual(["b", "c"]);
});

it("loading a later continuous track waits for metadata without announcing track zero", async () => {
  const { current, ids, load } = fixture("continuous");
  current.readyState = 0;
  const loading = load(false, 1);
  await vi.advanceTimersByTimeAsync(0);
  await loading;
  expect(ids()).toEqual(["b"]);
  current.currentTime = 21;
  await vi.advanceTimersByTimeAsync(4000);
  expect(current.currentTime).toBe(21);
  expect(ids()).toEqual(["b", "c"]);
});

it("warm discrete promotion detaches listeners from the previous element", async () => {
  const { engine, current, next, changes, ids, plays, load } = fixture("discrete");
  await load(true);
  await engine.prefetchNext();
  changes.length = 0;
  plays.mockClear();
  await engine.next();
  expect(engine.mediaElement).toBe(next);
  expect(ids()).toEqual(["b"]);
  expect(plays).toHaveBeenCalledTimes(1);
  await current.play();
  expect(ids()).toEqual(["b"]);
  expect(plays).toHaveBeenCalledTimes(1);
  await engine.prefetchNext();
  await engine.next();
  expect(engine.mediaElement).toBe(current);
  expect(ids()).toEqual(["b", "c"]);
});

it("discrete ended advances to the next track", async () => {
  const { current, changes, ids, load } = fixture("discrete");
  await load(true);
  changes.length = 0;
  current.paused = true;
  current.ended = true;
  current.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(0);
  expect(ids()).toEqual(["b"]);
});


it("continuous source refresh restores the clock before emitting playback metadata", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true, 1);
  current.currentTime = 13;
  changes.length = 0;
  current.readyState = 0;
  const replacing = engine.replaceSource({ url: "refreshed.m3u8" });
  await vi.advanceTimersByTimeAsync(0);
  await replacing;
  expect(current.currentTime).toBe(13);
  expect(ids()).toEqual(["b"]);
});

it("continuous source replacement without preservation announces the new current track", async () => {
  const { engine, changes, ids, load } = fixture("continuous");
  await load(false, 1);
  changes.length = 0;
  await engine.replaceSource({ url: "refreshed.m3u8", preservePosition: false });
  expect(ids()).toEqual(["a"]);
});

it("discrete source refresh re-announces the same playing track", async () => {
  const { engine, changes, ids, load } = fixture("discrete");
  await load(true);
  changes.length = 0;
  await engine.replaceSource({ url: "refreshed.mp3" });
  expect(ids()).toEqual(["a"]);
});


it("reselecting the already playing continuous track announces the restart", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true);
  changes.length = 0;
  current.currentTime = 7;
  await engine.playAt(0);
  expect(ids()).toEqual(["a"]);
  expect(engine.currentTime).toBeLessThan(0.1);
});

it("a newer continuous skip supersedes an in-flight skip", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true);
  changes.length = 0;
  current.readyState = 0;
  const first = engine.playAt(1);
  const second = engine.playAt(2);
  current.readyState = 1;
  current.dispatchEvent(new Event("loadedmetadata"));
  await Promise.all([first, second]);
  expect(ids()).toEqual(["c"]);
  expect(engine.currentIndex).toBe(2);
});

it("concurrent unlock callers wait for the same internal cycle", async () => {
  const { engine, current, ids, plays, pauses, load } = fixture("discrete");
  await load();
  let finishPlay!: () => void;
  current.play = async () => {
    current.paused = false;
    await new Promise<void>(resolve => { finishPlay = resolve; });
    current.dispatchEvent(new Event("play"));
  };
  const first = engine.unlock();
  const secondFinished = vi.fn();
  const second = engine.unlock().then(secondFinished);
  await Promise.resolve();
  expect(secondFinished).not.toHaveBeenCalled();
  finishPlay();
  await Promise.all([first, second]);
  expect(secondFinished).toHaveBeenCalledTimes(1);
  expect(ids()).toEqual(["a"]);
  expect(plays).not.toHaveBeenCalled();
  expect(pauses).not.toHaveBeenCalled();
});

it("unlock does not interrupt an element the host is already playing", async () => {
  const { engine, current, changes, ids, load } = fixture("discrete");
  await load();
  await current.play();
  current.currentTime = 3;
  current.muted = true;
  changes.length = 0;
  await engine.unlock();
  expect(engine.playing).toBe(true);
  expect(current.currentTime).toBe(3);
  expect(current.muted).toBe(true);
  expect(ids()).toEqual([]);
});
