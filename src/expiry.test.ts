import { describe, expect, it } from "vitest";
import { EXPIRY_SKEW_MS, isAbortError, isExpiringSoon } from "./expiry.js";

describe("isExpiringSoon", () => {
  it("is false when expiresAt is missing", () => {
    expect(isExpiringSoon(undefined, 1_000_000)).toBe(false);
  });

  it("is true inside the skew window", () => {
    const now = 1_000_000;
    expect(isExpiringSoon(now + EXPIRY_SKEW_MS - 1, now)).toBe(true);
    expect(isExpiringSoon(now + EXPIRY_SKEW_MS + 1, now)).toBe(false);
  });
});

describe("isAbortError", () => {
  it("detects AbortError by name", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
    expect(isAbortError(new Error("nope"))).toBe(false);
  });
});
