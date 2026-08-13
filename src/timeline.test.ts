import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  findTimelineIndex,
  timelineSeekTime,
} from "./timeline.js";

describe("buildTimeline", () => {
  it("accumulates start offsets", () => {
    const tl = buildTimeline([
      { id: "a", title: "A", duration: 10 },
      { id: "b", title: "B", duration: 20 },
      { id: "c", title: "C", duration: 5 },
    ]);
    expect(tl.map((e) => e.start)).toEqual([0, 10, 30]);
    expect(tl[2]!.duration).toBe(5);
  });
});

describe("findTimelineIndex", () => {
  const tl = buildTimeline([
    { id: "a", title: "A", duration: 10 },
    { id: "b", title: "B", duration: 20 },
  ]);

  it("maps times to tracks", () => {
    expect(findTimelineIndex(tl, 0)).toBe(0);
    expect(findTimelineIndex(tl, 9.99)).toBe(0);
    expect(findTimelineIndex(tl, 10)).toBe(1);
    expect(findTimelineIndex(tl, 25)).toBe(1);
  });
});

describe("timelineSeekTime", () => {
  it("avoids landing on previous track", () => {
    const entry = buildTimeline([{ id: "a", title: "A", duration: 100 }])[0]!;
    expect(timelineSeekTime(entry, 0)).toBeGreaterThan(0);
    expect(timelineSeekTime(entry, 50)).toBeCloseTo(50, 5);
  });
});
