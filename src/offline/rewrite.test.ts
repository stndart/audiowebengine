import { describe, expect, it } from "vitest";
import {
  OFFLINE_SW_PATH,
  offlinePlaybackUrl,
  rewriteM3u8,
} from "./index.js";

describe("rewriteM3u8", () => {
  it("rewrites URI lines only", () => {
    const src = [
      "#EXTM3U",
      "#EXTINF:10.0,",
      "seg.ts",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const out = rewriteM3u8(src, (u) => `https://cache.local/${u}`);
    expect(out).toContain("https://cache.local/seg.ts");
    expect(out).toContain("#EXTINF:10.0,");
  });
});

describe("offlinePlaybackUrl", () => {
  it("rewrites to a same-origin SW path", () => {
    const url = offlinePlaybackUrl(
      "https://cdn.example/seg.ts",
      "https://app.example",
    );
    expect(url.startsWith("https://app.example" + OFFLINE_SW_PATH)).toBe(true);
    expect(url).toContain(encodeURIComponent("https://cdn.example/seg.ts"));
  });
});
