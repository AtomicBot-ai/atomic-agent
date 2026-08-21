import { describe, expect, it } from "vitest";

import {
  computeRetryDelayMs,
  DEFAULT_SEARCH_RETRY_POLICY,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
} from "./retry-after.js";

const NOW = Date.parse("2026-08-20T12:00:00Z");

describe("parseRetryAfterMs", () => {
  it("reads the delta-seconds form", () => {
    expect(parseRetryAfterMs("2", NOW)).toBe(2000);
  });

  it("reads the HTTP-date form relative to now", () => {
    expect(parseRetryAfterMs("Thu, 20 Aug 2026 12:00:03 GMT", NOW)).toBe(3000);
  });

  it("clamps a hostile far-future value to the ceiling", () => {
    // One bad header must not stall an agent turn for minutes.
    expect(parseRetryAfterMs("3600", NOW)).toBe(MAX_RETRY_AFTER_MS);
  });

  it("treats an already-elapsed date as no wait", () => {
    expect(parseRetryAfterMs("Thu, 20 Aug 2026 11:59:00 GMT", NOW)).toBe(0);
  });

  it("returns null when absent or unparseable so backoff takes over", () => {
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs("", NOW)).toBeNull();
    expect(parseRetryAfterMs("soon", NOW)).toBeNull();
    // Must not accept a partially-numeric value as 10 seconds.
    expect(parseRetryAfterMs("10abc", NOW)).toBeNull();
  });
});

describe("computeRetryDelayMs", () => {
  it("doubles the base delay per attempt when the server gave no header", () => {
    const policy = DEFAULT_SEARCH_RETRY_POLICY;
    expect(computeRetryDelayMs({ attempt: 1, policy, retryAfterMs: null })).toBe(500);
    expect(computeRetryDelayMs({ attempt: 2, policy, retryAfterMs: null })).toBe(1000);
    expect(computeRetryDelayMs({ attempt: 3, policy, retryAfterMs: null })).toBe(2000);
  });

  it("prefers the server's Retry-After over its own schedule", () => {
    expect(
      computeRetryDelayMs({
        attempt: 1,
        policy: DEFAULT_SEARCH_RETRY_POLICY,
        retryAfterMs: 4000,
      }),
    ).toBe(4000);
  });

  it("clamps its own exponential schedule to the ceiling", () => {
    expect(
      computeRetryDelayMs({
        attempt: 20,
        policy: DEFAULT_SEARCH_RETRY_POLICY,
        retryAfterMs: null,
      }),
    ).toBe(MAX_RETRY_AFTER_MS);
  });
});
