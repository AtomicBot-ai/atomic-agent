import { describe, expect, it } from "vitest";

import { parseSentryDsn } from "./sentry-config.js";

describe("parseSentryDsn", () => {
  it("parses a standard ingest DSN", () => {
    const parsed = parseSentryDsn(
      "https://abc123@o42.ingest.sentry.io/987",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.publicKey).toBe("abc123");
    expect(parsed?.host).toBe("o42.ingest.sentry.io");
    expect(parsed?.projectId).toBe("987");
    expect(parsed?.envelopeUrl).toBe(
      "https://o42.ingest.sentry.io/api/987/envelope/",
    );
  });

  it("handles a DSN with a path prefix", () => {
    const parsed = parseSentryDsn("https://key@example.com/base/55");
    expect(parsed?.envelopeUrl).toBe(
      "https://example.com/base/api/55/envelope/",
    );
  });

  it("returns null for a DSN without a public key", () => {
    expect(parseSentryDsn("https://o1.ingest.sentry.io/1")).toBeNull();
  });

  it("returns null for a malformed DSN", () => {
    expect(parseSentryDsn("not-a-url")).toBeNull();
    expect(parseSentryDsn("PLACEHOLDER")).toBeNull();
  });
});
