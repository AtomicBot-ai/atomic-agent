import { describe, expect, it, vi } from "vitest";

import { assertAsciiApiKey, isAsciiOnly } from "./ascii-header-guard.js";
import { buildOpenAiAuthHeaders } from "./openai-auth-headers.js";
import {
  buildOpenAiHeaders,
  OpenAiHttpError,
  openAiFetch,
} from "./openai-http.js";

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

describe("buildOpenAiAuthHeaders header guard", () => {
  it("guards the named api-key header path, not just the bearer default", () => {
    // Anthropic-style presets carry the key in `x-api-key`; the assert
    // sits in the one builder both paths share, so this throws too.
    expect(() =>
      buildOpenAiAuthHeaders("sk-т", { apiKeyHeader: "x-api-key" }),
    ).toThrow(/non-ASCII/);
  });

  it("passes an ASCII key through to the named header", () => {
    const headers = buildOpenAiAuthHeaders("sk-ok", { apiKeyHeader: "x-api-key" });
    expect(headers["x-api-key"]).toBe("sk-ok");
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

  it("classifies a non-ASCII key as a 401 at request time, before any fetch", async () => {
    // A legacy bad key in .env reaches openAiFetch directly. It must fail
    // as an auth error — deterministic, unretried, and a fallback chain
    // advances past it — with the guard's message intact, not wrapped as
    // a network failure.
    const fetchImpl = vi.fn();
    let caught: unknown;
    try {
      await openAiFetch({ ...deps, apiKey: "sk-т", fetchImpl }, "/v1/chat", null, {}, false);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenAiHttpError);
    expect((caught as OpenAiHttpError).status).toBe(401);
    expect((caught as Error).message).toContain("non-ASCII");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
