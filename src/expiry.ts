/** Treat a signed URL as stale this far before `expiresAt`. */
export const EXPIRY_SKEW_MS = 15_000;

export function isExpiringSoon(
  expiresAt?: number,
  now = Date.now(),
  skewMs = EXPIRY_SKEW_MS,
): boolean {
  if (expiresAt == null || !Number.isFinite(expiresAt)) return false;
  return now + skewMs >= expiresAt;
}

export function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  return name === "AbortError" || name === "TimeoutError";
}
