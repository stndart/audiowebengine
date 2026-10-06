import { afterEach, expect, it, vi } from "vitest";
import { attachHls } from "./hls-js.js";

const harness = vi.hoisted(() => ({
  listeners: new Map<string, (event: string, data: { fatal: boolean; error?: Error; details?: string }) => void>(),
}));

vi.mock("hls.js/light", () => ({
  default: class {
    static isSupported() { return true; }
    static Events = { ERROR: "hlsError" };
    config = { maxMaxBufferLength: 30, maxBufferLength: 30 };
    on(event: string, handler: (event: string, data: { fatal: boolean }) => void) {
      harness.listeners.set(event, handler);
    }
    off(event: string) { harness.listeners.delete(event); }
    loadSource() {}
    attachMedia() {}
    destroy() {}
  },
}));

afterEach(() => harness.listeners.clear());

function audioFixture() {
  return { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() } as unknown as HTMLAudioElement;
}

it("forwards fatal HLS failures and leaves recoverable failures to hls.js", async () => {
  const onError = vi.fn();
  const media = await attachHls(audioFixture(), "source.m3u8", { onError });
  const handler = harness.listeners.get("hlsError")!;
  handler("hlsError", { fatal: false, details: "recoverable network error" });
  expect(onError).not.toHaveBeenCalled();
  const error = new Error("fatal network error");
  handler("hlsError", { fatal: true, error });
  expect(onError).toHaveBeenCalledWith(error);
  media.destroy();
  handler("hlsError", { fatal: true, error });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(harness.listeners.size).toBe(0);
});

it("an aborted attach does not register a source or error listener", async () => {
  await expect(attachHls(audioFixture(), "cancelled.m3u8", { signal: AbortSignal.abort() }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(harness.listeners.size).toBe(0);
});
