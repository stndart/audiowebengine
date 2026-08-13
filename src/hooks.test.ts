import { describe, expect, it } from "vitest";
import { createEngineEmitter } from "./events.js";
import { HookTracker } from "./hooks.js";

describe("HookTracker", () => {
  it("fires beforeend once when remaining <= threshold", () => {
    const emitter = createEngineEmitter();
    const fired: number[] = [];
    emitter.on("beforeend", (p) => fired.push(p.secondsRemaining));
    const tracker = new HookTracker({ beforeEndSeconds: 5 });
    tracker.tick(emitter, 90, 100);
    tracker.tick(emitter, 96, 100);
    tracker.tick(emitter, 99, 100);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toBe(4);
  });

  it("fires each progress threshold once", () => {
    const emitter = createEngineEmitter();
    const percents: number[] = [];
    emitter.on("progress", (p) => percents.push(p.percent));
    const tracker = new HookTracker({ progressPercents: [30, 90] });
    tracker.tick(emitter, 10, 100);
    tracker.tick(emitter, 30, 100);
    tracker.tick(emitter, 50, 100);
    tracker.tick(emitter, 91, 100);
    expect(percents).toEqual([30, 90]);
  });

  it("reset allows beforeend to fire again", () => {
    const emitter = createEngineEmitter();
    let n = 0;
    emitter.on("beforeend", () => {
      n += 1;
    });
    const tracker = new HookTracker({ beforeEndSeconds: 5 });
    tracker.tick(emitter, 96, 100);
    tracker.reset();
    tracker.tick(emitter, 96, 100);
    expect(n).toBe(2);
  });
});
