import { describe, expect, it } from "vitest";

import { parseRetryAfterValueMs } from "./retry-after-header.js";

const NOW = Date.parse("2026-08-20T12:00:00Z");

describe("parseRetryAfterValueMs", () => {
  it("reads the delta-seconds form", () => {
    expect(parseRetryAfterValueMs("120", NOW)).toBe(120_000);
  });

  it("reads the HTTP-date form relative to now", () => {
    expect(parseRetryAfterValueMs("Thu, 20 Aug 2026 12:00:05 GMT", NOW)).toBe(5000);
  });

  it("clamps an already-elapsed date to zero rather than negative", () => {
    expect(parseRetryAfterValueMs("Thu, 20 Aug 2026 11:00:00 GMT", NOW)).toBe(0);
  });

  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfterValueMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterValueMs(null, NOW)).toBeNull();
    expect(parseRetryAfterValueMs("", NOW)).toBeNull();
    expect(parseRetryAfterValueMs("   ", NOW)).toBeNull();
    expect(parseRetryAfterValueMs("soon", NOW)).toBeNull();
  });

  it("rejects a partially-numeric value instead of reading it as seconds", () => {
    expect(parseRetryAfterValueMs("10abc", NOW)).toBeNull();
  });
});
