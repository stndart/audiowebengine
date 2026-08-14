import { describe, expect, it, vi } from "vitest";
import { bufferedAheadSeconds } from "./hls-buffer.js";
import {
  estimatePrefetchBytes,
  PrefetchController,
  progressivePreloadFor,
  warmProgressiveRange,
} from "./progressive-range.js";

describe("estimatePrefetchBytes", () => {
  it("uses byteRateHint when present", () => {
    expect(estimatePrefetchBytes(10, 100_000)).toBe(1_000_000);
  });

  it("floors to a minimum", () => {
    expect(estimatePrefetchBytes(0.001, 1)).toBe(64_000);
  });
});

describe("progressivePreloadFor", () => {
  it("loads the warm slot instead of leaving src idle", () => {
    expect(progressivePreloadFor("play")).toBe("auto");
    expect(progressivePreloadFor("prefetch-next")).toBe("auto");
  });
});

describe("PrefetchController", () => {
  it("bump aborts the previous signal", () => {
    const ctrl = new PrefetchController();
    ctrl.bump();
    const first = ctrl.signal!;
    expect(first.aborted).toBe(false);
    ctrl.bump();
    expect(first.aborted).toBe(true);
    expect(ctrl.signal!.aborted).toBe(false);
    ctrl.destroy();
  });
});

describe("warmProgressiveRange", () => {
  it("sends a Range header and does not touch Cache API", async () => {
    const cachesOpen = vi.fn();
    vi.stubGlobal("caches", { open: cachesOpen });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const range = new Headers(init?.headers).get("Range");
        expect(range).toMatch(/^bytes=0-\d+$/);
        return new Response(new Uint8Array(64_000), { status: 206 });
      }),
    );

    const result = await warmProgressiveRange(
      { kind: "progressive", url: "https://cdn.example/a.flac" },
      { seconds: 12 },
    );
    expect(result.aborted).toBe(false);
    expect(result.bytes).toBe(64_000);
    expect(cachesOpen).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns aborted on AbortError", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw err;
    }));
    const result = await warmProgressiveRange(
      { kind: "progressive", url: "https://cdn.example/a.flac" },
      { seconds: 12 },
    );
    expect(result.aborted).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("bufferedAheadSeconds", () => {
  it("reads TimeRanges ahead of currentTime", () => {
    const audio = {
      currentTime: 2,
      buffered: {
        length: 1,
        start: () => 0,
        end: () => 17,
      },
    } as unknown as HTMLMediaElement;
    expect(bufferedAheadSeconds(audio)).toBe(15);
  });
});
