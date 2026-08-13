import { describe, expect, it } from "vitest";
import { TimeupdateGate } from "./timeupdate-gate.js";

describe("TimeupdateGate", () => {
  it("emits the first snapshot", () => {
    const gate = new TimeupdateGate();
    expect(gate.next(1, 100)).toEqual({ currentTime: 1, duration: 100 });
  });

  it("suppresses an unchanged snapshot", () => {
    const gate = new TimeupdateGate();
    gate.next(1, 100);
    expect(gate.next(1, 100)).toBeNull();
  });

  it("emits when currentTime changes", () => {
    const gate = new TimeupdateGate();
    gate.next(1, 100);
    expect(gate.next(1.25, 100)).toEqual({
      currentTime: 1.25,
      duration: 100,
    });
  });

  it("emits when duration changes", () => {
    const gate = new TimeupdateGate();
    gate.next(0, 0);
    expect(gate.next(0, 180)).toEqual({ currentTime: 0, duration: 180 });
  });

  it("re-emits an unchanged snapshot when forced", () => {
    const gate = new TimeupdateGate();
    gate.next(12, 100);
    expect(gate.next(12, 100, true)).toEqual({
      currentTime: 12,
      duration: 100,
    });
  });

  it("emits again after reset", () => {
    const gate = new TimeupdateGate();
    gate.next(0, 180);
    gate.reset();
    expect(gate.next(0, 180)).toEqual({ currentTime: 0, duration: 180 });
  });
});
