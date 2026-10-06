import { afterEach, expect, it, vi } from "vitest";
import { seekMedia } from "./media-position.js";

afterEach(() => vi.useRealTimers());

function audioFixture() {
  return Object.assign(new EventTarget(), { readyState: 0, currentTime: 0 }) as unknown as HTMLAudioElement;
}

it("cancellation removes pending metadata work without changing the clock", async () => {
  vi.useFakeTimers();
  const audio = audioFixture();
  const abort = new AbortController();
  const seeking = seekMedia(audio, 17, abort.signal);
  abort.abort();
  expect(await seeking).toBe(false);
  audio.dispatchEvent(new Event("loadedmetadata"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(audio.currentTime).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("a successful metadata seek cancels its fallback timer", async () => {
  vi.useFakeTimers();
  const audio = audioFixture();
  const seeking = seekMedia(audio, 17, new AbortController().signal);
  audio.dispatchEvent(new Event("loadedmetadata"));
  expect(await seeking).toBe(true);
  audio.currentTime = 20;
  await vi.advanceTimersByTimeAsync(5000);
  expect(audio.currentTime).toBe(20);
  expect(vi.getTimerCount()).toBe(0);
});
