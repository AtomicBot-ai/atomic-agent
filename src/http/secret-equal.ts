import { timingSafeEqual } from "node:crypto";

/**
 * Compare a caller-provided secret against the expected one in constant
 * time, so a remote client cannot recover the secret byte by byte from
 * response timing when the server is reachable from outside. A missing,
 * empty or different-length value never matches; only the length is
 * observable, which `timingSafeEqual` requires to be equal anyway.
 */
export function secretEquals(
  provided: string | null | undefined,
  expected: string,
): boolean {
  if (typeof provided !== "string" || provided.length === 0) return false;
  if (expected.length === 0) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
