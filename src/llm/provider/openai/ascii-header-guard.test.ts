import { describe, expect, it } from "vitest";

import { assertAsciiApiKey, isAsciiOnly } from "./ascii-header-guard.js";
import { buildOpenAiHeaders } from "./openai-http.js";

describe("isAsciiOnly", () => {
  it("accepts plain ASCII keys and the empty string", () => {
    expect(isAsciiOnly("")).toBe(true);
    expect(isAsciiOnly("sk-abc123_-.")).toBe(true);
    // Every printable ASCII byte is allowed in a header value.
    expect(isAsciiOnly("Bearer sk-XYZ~!@#$%^&*()")).toBe(true);
  });

  it("rejects a key with a character above the ASCII range", () => {
    expect(isAsciiOnly("sk-т")).toBe(false); // Cyrillic "т" (U+0442)
    expect(isAsciiOnly("sk-café")).toBe(false); // "é" (U+00E9)
    expect(isAsciiOnly("sk-“smart”")).toBe(false); // curly quotes
  });
});

describe("assertAsciiApiKey", () => {
  it("returns an ASCII key unchanged", () => {
    expect(assertAsciiApiKey("sk-plain")).toBe("sk-plain");
  });

  it("throws a clear, actionable error for a non-ASCII key", () => {
    expect(() => assertAsciiApiKey("sk-т")).toThrow(
      "API key contains non-ASCII characters. Use a plain ASCII key.",
    );
  });
});

describe("buildOpenAiHeaders header guard", () => {
  const deps = {
    baseUrl: "http://127.0.0.1:9931",
    extraHeaders: {},
    requestTimeoutMs: 1000,
    fetchImpl: fetch,
    label: "local",
  };

  it("does not throw a raw ByteString error for a non-ASCII key", () => {
    // The header building must fail with our named error, never the
    // opaque "Cannot convert argument to a ByteString" from `fetch`.
    let caught: unknown;
    try {
      buildOpenAiHeaders({ ...deps, apiKey: "sk-т" }, false);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("non-ASCII");
    expect((caught as Error).message).not.toContain("ByteString");
  });

  it("builds an Authorization header for an ASCII key", () => {
    const headers = buildOpenAiHeaders({ ...deps, apiKey: "sk-ok" }, false);
    expect(headers.authorization).toBe("Bearer sk-ok");
  });

  it("omits Authorization entirely for a keyless server", () => {
    const headers = buildOpenAiHeaders({ ...deps, apiKey: "" }, false);
    expect(headers.authorization).toBeUndefined();
  });
});
