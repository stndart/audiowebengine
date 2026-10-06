import { afterEach, describe, expect, it, vi } from "vitest";
import { createAudioStore } from "./svelte/index.js";
import { attachSource } from "./transports/attach.js";
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

const adapter: SourceAdapter & Required<Pick<SourceAdapter, "resolveContinuous">> = {
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(mode: "discrete" | "continuous") {
  vi.useFakeTimers();
  const current = new TestAudio();
  const next = new TestAudio();
  const engine = new AudioEngine({ prefetch: { enabled: true }, hooks: { progressPercents: [30, 100] } });
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

  it("announces selection once without confusing resume with a track change", async () => {
    const { engine, ids, plays, pauses, load } = fixture(mode);
    await load(true);
    expect(ids()).toEqual(["a"]);
    expect(plays).toHaveBeenCalledTimes(1);
    expect(pauses).not.toHaveBeenCalled();
    await engine.pause();
    await engine.play();
    expect(ids()).toEqual(["a"]);
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
    expect(ids()).toEqual(["a"]);
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


it("continuous source refresh preserves track identity and position", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true, 1);
  current.currentTime = 13;
  changes.length = 0;
  current.readyState = 0;
  const replacing = engine.replaceSource({ url: "refreshed.m3u8" });
  await vi.advanceTimersByTimeAsync(0);
  await replacing;
  expect(current.currentTime).toBe(13);
  expect(ids()).toEqual([]);
});

it("continuous source replacement without preservation announces the new current track", async () => {
  const { engine, changes, ids, load } = fixture("continuous");
  await load(false, 1);
  changes.length = 0;
  await engine.replaceSource({ url: "refreshed.m3u8", preservePosition: false });
  expect(ids()).toEqual(["a"]);
});

it("discrete source refresh does not change track identity", async () => {
  const { engine, changes, ids, load } = fixture("discrete");
  await load(true);
  changes.length = 0;
  await engine.replaceSource({ url: "refreshed.mp3" });
  expect(ids()).toEqual([]);
});


it("reselecting the already playing continuous track preserves position", async () => {
  const { engine, current, changes, ids, load } = fixture("continuous");
  await load(true);
  changes.length = 0;
  current.currentTime = 7;
  await engine.playAt(0);
  expect(ids()).toEqual([]);
  expect(engine.currentTime).toBe(7);
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


describe.each(["discrete", "continuous"] as const)("%s event contract", mode => {
  it("repeatedly requesting the current item preserves position, sources and events", async () => {
    const { engine, current, changes, ids, plays, pauses, load } = fixture(mode);
    await load(true);
    current.currentTime = 6;
    const attachCount = vi.mocked(attachSource).mock.calls.length;
    changes.length = 0;
    plays.mockClear();
    pauses.mockClear();
    await engine.playAt(0);
    await engine.playAt(0);
    expect(current.currentTime).toBe(6);
    expect(ids()).toEqual([]);
    expect(plays).not.toHaveBeenCalled();
    expect(pauses).not.toHaveBeenCalled();
    expect(vi.mocked(attachSource).mock.calls).toHaveLength(attachCount);
    await engine.pause();
    plays.mockClear();
    await engine.playAt(0);
    expect(current.currentTime).toBe(6);
    expect(ids()).toEqual([]);
    expect(plays).toHaveBeenCalledTimes(1);
  });

  it("emits playback transitions once, even if native events repeat", async () => {
    const { engine, current, plays, pauses, ids, load } = fixture(mode);
    await load(true);
    current.dispatchEvent(new Event("play"));
    await engine.play();
    expect(plays).toHaveBeenCalledTimes(1);
    await engine.pause();
    current.dispatchEvent(new Event("pause"));
    await engine.pause();
    expect(pauses).toHaveBeenCalledTimes(1);
    await engine.play();
    expect(plays).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(["a"]);
  });

  it("publishes coherent event sequences when skipping", async () => {
    const { engine, load } = fixture(mode);
    const sequence: string[] = [];
    engine.on("play", () => {
      expect(engine.playing).toBe(true);
      sequence.push(`play:${engine.currentMeta?.id}`);
    });
    engine.on("pause", () => {
      expect(engine.playing).toBe(false);
      sequence.push(`pause:${engine.currentMeta?.id}`);
    });
    engine.on("trackchange", ({ track }) => sequence.push(`track:${track.id}`));
    await load(true);
    expect(sequence).toEqual(["track:a", "play:a"]);
    sequence.length = 0;
    await engine.next();
    expect(sequence).toEqual(mode === "discrete"
      ? ["pause:a", "track:b", "play:b"]
      : ["track:b"]);
  });

  it("emits no track/playback events for a seek within the selected track", async () => {
    const { engine, changes, ids, plays, pauses, load } = fixture(mode);
    await load(true);
    changes.length = 0;
    plays.mockClear();
    pauses.mockClear();
    const times = vi.fn();
    engine.on("timeupdate", times);
    await engine.seek(4);
    expect(engine.currentTime).toBeCloseTo(4);
    expect(times).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
    expect(plays).not.toHaveBeenCalled();
    expect(pauses).not.toHaveBeenCalled();
    await engine.seek(Number.NaN);
    await engine.seek(4);
    expect(times).toHaveBeenCalledTimes(1);
  });

  it("paused seeks do not emit playback progress hooks", async () => {
    const { engine, load } = fixture(mode);
    const beforeend = vi.fn();
    const progress = vi.fn();
    engine.on("beforeend", beforeend);
    engine.on("progress", progress);
    await load();
    await engine.seek(8);
    await vi.advanceTimersByTimeAsync(1000);
    expect(beforeend).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    await engine.play();
    expect(beforeend).toHaveBeenCalledTimes(1);
  });

  it("an unchanged playAt does not reset per-track hooks or start a new prefetch", async () => {
    const { engine, current, load } = fixture(mode);
    const beforeend = vi.fn();
    engine.on("beforeend", beforeend);
    await load(true);
    current.currentTime = 6;
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeend).toHaveBeenCalledTimes(1);
    await engine.playAt(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeend).toHaveBeenCalledTimes(1);
    expect(current.currentTime).toBe(6);
  });

  it("source refresh preserves position before playback resumes, without trackchange", async () => {
    const { engine, current, changes, ids, plays, pauses, load } = fixture(mode);
    await load(true);
    current.currentTime = 4;
    changes.length = 0;
    plays.mockClear();
    pauses.mockClear();
    engine.on("play", () => expect(engine.currentTime).toBeCloseTo(4));
    current.readyState = 0;
    const replacing = engine.replaceSource({ url: mode === "discrete" ? "fresh.mp3" : "fresh.m3u8" });
    await vi.advanceTimersByTimeAsync(0);
    await replacing;
    expect(ids()).toEqual([]);
    expect(plays).toHaveBeenCalledTimes(1);
    expect(pauses).toHaveBeenCalledTimes(1);
  });

  it("different queues announce the same track once; reloading the same identity does not", async () => {
    const { engine, changes, ids, load } = fixture(mode);
    await load();
    changes.length = 0;
    const options = mode === "discrete"
      ? { mode, ids: ["a", "b", "c"], queueId: "q2", autoplay: false }
      : { mode, queueKey: "q2", autoplay: false };
    await engine.load(options);
    expect(ids()).toEqual(["a"]);
    await engine.load(options);
    expect(ids()).toEqual(["a"]);
  });

  it("ending the last item emits pause and ended once, with final progress", async () => {
    const { engine, current, changes, ids, pauses, load } = fixture(mode);
    await load(true, 2);
    changes.length = 0;
    pauses.mockClear();
    const ends = vi.fn(() => expect(engine.playing).toBe(false));
    const progress: number[] = [];
    engine.on("ended", ends);
    engine.on("progress", ({ percent }) => progress.push(percent));
    current.currentTime = mode === "discrete" ? 10 : 30;
    current.paused = true;
    current.ended = true;
    current.dispatchEvent(new Event("ended"));
    current.dispatchEvent(new Event("ended"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ends).toHaveBeenCalledTimes(1);
    expect(pauses).toHaveBeenCalledTimes(1);
    expect(progress).toContain(100);
    expect(ids()).toEqual([]);
  });

  it("adapter failures produce an error event and a cleared selection", async () => {
    const { engine, load } = fixture(mode);
    await load();
    const errors = vi.fn();
    const clears = vi.fn();
    engine.on("error", errors);
    engine.on("trackclear", clears);
    const error = new Error("resolve failed");
    if (mode === "discrete") vi.spyOn(adapter, "resolve").mockRejectedValueOnce(error);
    else vi.spyOn(adapter, "resolveContinuous").mockRejectedValueOnce(error);
    await engine.load(mode === "discrete"
      ? { mode, ids: ["x"], queueId: "other" }
      : { mode, queueKey: "other" });
    expect(errors).toHaveBeenCalledWith({ error });
    expect(clears).toHaveBeenCalledTimes(1);
    expect(engine.currentMeta).toBeUndefined();
    expect(engine.playing).toBe(false);
  });

  it("does not emit errors or playback from a superseded load", async () => {
    const { engine, ids } = fixture(mode);
    let rejectOld!: (error: unknown) => void;
    if (mode === "discrete") {
      vi.spyOn(adapter, "resolve").mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    } else {
      vi.spyOn(adapter, "resolveContinuous").mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
    }
    const errors = vi.fn();
    engine.on("error", errors);
    const older = engine.load(mode === "discrete"
      ? { mode, ids: ["old"], queueId: "old" }
      : { mode, queueKey: "old" });
    await engine.load(mode === "discrete"
      ? { mode, ids: ["b"], queueId: "new" }
      : { mode, queueKey: "new", startIndex: 1 });
    rejectOld(new Error("late stale error"));
    await older;
    expect(ids()).toEqual(["b"]);
    expect(engine.currentMeta?.id).toBe("b");
    expect(errors).not.toHaveBeenCalled();
  });

  it("destroy cancels delayed metadata work and emits no further events", async () => {
    const { engine, current, changes, ids, plays, load } = fixture(mode);
    await load(true);
    current.currentTime = 3;
    changes.length = 0;
    plays.mockClear();
    current.readyState = 0;
    const replacing = engine.replaceSource({ url: "fresh.m3u8" });
    await Promise.resolve();
    await Promise.resolve();
    engine.destroy();
    current.dispatchEvent(new Event("loadedmetadata"));
    await replacing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(ids()).toEqual([]);
    expect(plays).not.toHaveBeenCalled();
    expect(engine.mode).toBeNull();
    expect(engine.playing).toBe(false);
    expect(current.currentTime).not.toBe(3);
  });
});

it("clearing a queue publishes trackclear and updates the Svelte snapshot", async () => {
  const { engine, load } = fixture("discrete");
  await load(true);
  let currentId: string | undefined;
  const unsubscribe = createAudioStore(engine).subscribe(state => { currentId = state.currentMeta?.id; });
  const clears = vi.fn();
  const errors = vi.fn();
  engine.on("trackclear", clears);
  engine.on("error", errors);
  await engine.load({ mode: "discrete", ids: [], queueId: "empty" });
  expect(currentId).toBeUndefined();
  expect(clears).toHaveBeenCalledTimes(1);
  await engine.play();
  await engine.seek(1);
  await engine.load({ mode: "discrete", ids: [], queueId: "empty" });
  expect(clears).toHaveBeenCalledTimes(1);
  expect(errors).not.toHaveBeenCalled();
  unsubscribe();
});


it("a cancelled prefetch does not block a new prefetch for the same next item", async () => {
  const { engine, load } = fixture("discrete");
  await load(true);
  let finishOld!: () => void;
  const originalResolve = adapter.resolve;
  const resolve = vi.spyOn(adapter, "resolve");
  resolve.mockImplementationOnce(async (id, context) => {
    await new Promise<void>(done => { finishOld = done; });
    return originalResolve(id, context);
  });
  const old = engine.prefetchNext();
  await engine.replaceSource({ url: "fresh.mp3" });
  await engine.prefetchNext();
  expect(resolve).toHaveBeenCalledTimes(2);
  finishOld();
  await old;
  await engine.next();
  expect(engine.currentMeta?.id).toBe("b");
});

it("the same track id at a different queue position is a different item", async () => {
  const { engine, changes } = fixture("discrete");
  await engine.load({ mode: "discrete", ids: ["a", "a"], queueId: "duplicates" });
  changes.length = 0;
  await engine.playAt(1);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({ index: 1, track: { id: "a" } });
});


describe.each(["discrete", "continuous"] as const)("%s pending playback intent", mode => {
  it("pause during a pending load prevents its autoplay", async () => {
    const { engine, current, plays, ids } = fixture(mode);
    const originalResolve = adapter.resolve;
    const originalContinuous = adapter.resolveContinuous;
    let finish!: () => void;
    if (mode === "discrete") {
      vi.spyOn(adapter, "resolve").mockImplementationOnce(async (id, context) => {
        await new Promise<void>(done => { finish = done; });
        return originalResolve(id, context);
      });
    } else {
      vi.spyOn(adapter, "resolveContinuous").mockImplementationOnce(async (id, context) => {
        await new Promise<void>(done => { finish = done; });
        return originalContinuous(id, context);
      });
    }
    const loading = engine.load(mode === "discrete"
      ? { mode, ids: ["a"], queueId: "q", autoplay: true }
      : { mode, queueKey: "q", autoplay: true });
    await engine.pause();
    finish();
    await loading;
    expect(ids()).toEqual(["a"]);
    expect(engine.playing).toBe(false);
    expect(current.paused).toBe(true);
    expect(plays).not.toHaveBeenCalled();
  });

  it("pause during a pending source refresh prevents its automatic resume", async () => {
    const { engine, current, plays, load } = fixture(mode);
    await load(true);
    current.currentTime = 4;
    current.readyState = 0;
    plays.mockClear();
    const refreshing = engine.replaceSource({ url: "fresh.m3u8" });
    await engine.pause();
    await vi.advanceTimersByTimeAsync(0);
    await refreshing;
    expect(engine.playing).toBe(false);
    expect(current.paused).toBe(true);
    expect(current.currentTime).toBe(4);
    expect(plays).not.toHaveBeenCalled();
  });
});


it("a newer load waits for existing pool priming before attaching and seeking its source", async () => {
  const { engine, current, load } = fixture("continuous");
  let finishPrime!: () => void;
  let started!: () => void;
  const priming = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(current, "play").mockImplementationOnce(async () => {
    current.paused = false;
    started();
    await new Promise<void>(resolve => { finishPrime = resolve; });
    current.dispatchEvent(new Event("play"));
  });
  const first = load(true);
  await priming;
  const next = engine.load({ mode: "continuous", queueKey: "new", startIndex: 1, autoplay: true });
  finishPrime();
  await Promise.all([first, next]);
  expect(engine.currentMeta?.id).toBe("b");
  expect(engine.currentIndex).toBe(1);
  expect(current.currentTime).toBeGreaterThan(10);
  expect(engine.playing).toBe(true);
});
