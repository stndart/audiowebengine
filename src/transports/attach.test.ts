import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachSource } from "./attach.js";
import { attachHls } from "./hls-js.js";
import type { AttachedMedia } from "../types.js";

vi.mock("./hls-js.js", () => ({ attachHls: vi.fn() }));

class TestAudio extends EventTarget {
  src = "";
  preload = "none";
  paused = true;
  pause() { this.paused = true; }
  load() {}
  removeAttribute(name: string) { if (name === "src") this.src = ""; }
}

function audioFixture() {
  return new TestAudio() as unknown as HTMLAudioElement;
}

beforeEach(() => {
  vi.mocked(attachHls).mockReset();
  vi.mocked(attachHls).mockImplementation(async (audio, url) => {
    audio.src = url;
    return { destroy() { audio.removeAttribute("src"); } };
  });
});

describe("source ownership", () => {
  it("disposing an old handle cannot pause or clear the successor source", async () => {
    const audio = audioFixture();
    const old = await attachSource(audio, { kind: "progressive", url: "old.mp3" });
    await attachSource(audio, { kind: "progressive", url: "new.mp3" });
    Object.assign(audio, { paused: false });
    old.destroy();
    old.destroy();
    expect(audio.src).toBe("new.mp3");
    expect(audio.paused).toBe(false);
  });

  it("a cancelled async HLS attachment is disposed before the next source attaches", async () => {
    const audio = audioFixture();
    const abort = new AbortController();
    let finish!: () => void;
    const destroy = vi.fn(() => audio.removeAttribute("src"));
    vi.mocked(attachHls).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      audio.src = "stale.m3u8";
      return { destroy };
    });
    const old = attachSource(audio, { kind: "hls", url: "stale.m3u8" }, { signal: abort.signal });
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    abort.abort();
    const fresh = attachSource(audio, { kind: "progressive", url: "fresh.mp3" });
    finish();
    await rejected;
    await fresh;
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(audio.src).toBe("fresh.mp3");
  });

  it("queued attachment failure does not block a later source", async () => {
    const audio = audioFixture();
    vi.mocked(attachHls).mockRejectedValueOnce(new Error("HLS failed"));
    const failed = attachSource(audio, { kind: "hls", url: "bad.m3u8" });
    const next = attachSource(audio, { kind: "progressive", url: "good.mp3" });
    await expect(failed).rejects.toThrow("HLS failed");
    await next;
    expect(audio.src).toBe("good.mp3");
  });

  it("an already cancelled request leaves the current source attached", async () => {
    const audio = audioFixture();
    await attachSource(audio, { kind: "progressive", url: "current.mp3" });
    const signal = AbortSignal.abort();
    await expect(attachSource(audio, { kind: "hls", url: "cancelled.m3u8" }, { signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(audio.src).toBe("current.mp3");
    expect(attachHls).not.toHaveBeenCalled();
  });

  it("automatically disposes the previous attachment only once", async () => {
    const audio = audioFixture();
    const destroy = vi.fn();
    vi.mocked(attachHls).mockResolvedValueOnce({ destroy } as AttachedMedia);
    const old = await attachSource(audio, { kind: "hls", url: "first.m3u8" });
    await attachSource(audio, { kind: "progressive", url: "next.mp3" });
    old.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
