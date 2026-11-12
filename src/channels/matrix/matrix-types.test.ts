import { describe, expect, it } from "vitest";

import {
  isMatrixUserId,
  normalizeHomeserver,
  readMatrixOptions,
  resolveMatrixToken,
  scrubMatrixError,
} from "./matrix-types.js";

const config = (options: Record<string, string | number | boolean>) => ({
  enabled: true,
  ownerIds: ["@ada:example.org"],
  options,
});

describe("normalizeHomeserver", () => {
  it("keeps an https origin and drops a trailing slash", () => {
    expect(normalizeHomeserver(" https://matrix.org/ ")).toBe("https://matrix.org");
    expect(normalizeHomeserver("https://example.org/matrix/")).toBe("https://example.org/matrix");
  });

  it("refuses plain http except on loopback", () => {
    expect(normalizeHomeserver("http://matrix.example.org")).toBeNull();
    expect(normalizeHomeserver("http://localhost:8008")).toBe("http://localhost:8008");
    expect(normalizeHomeserver("http://127.0.0.1:8008")).toBe("http://127.0.0.1:8008");
  });

  it("refuses junk, other schemes and query strings", () => {
    expect(normalizeHomeserver("")).toBeNull();
    expect(normalizeHomeserver("matrix.org")).toBeNull();
    expect(normalizeHomeserver("ftp://matrix.org")).toBeNull();
    expect(normalizeHomeserver("https://matrix.org/?x=1")).toBeNull();
  });
});

describe("readMatrixOptions", () => {
  it("reads homeserver and a valid userId", () => {
    expect(
      readMatrixOptions(config({ homeserver: "https://matrix.org", userId: "@bot:matrix.org" })),
    ).toEqual({ homeserver: "https://matrix.org", userId: "@bot:matrix.org" });
  });

  it("treats a missing homeserver or malformed userId as absent", () => {
    expect(readMatrixOptions(config({ userId: "bot" }))).toEqual({ homeserver: null, userId: null });
    expect(readMatrixOptions(config({ homeserver: 5 }))).toEqual({ homeserver: null, userId: null });
  });
});

describe("isMatrixUserId", () => {
  it("accepts @local:server only", () => {
    expect(isMatrixUserId("@ada:example.org")).toBe(true);
    expect(isMatrixUserId("ada:example.org")).toBe(false);
    expect(isMatrixUserId("@ada")).toBe(false);
  });
});

describe("resolveMatrixToken", () => {
  it("prefers the explicit value, else a non-blank env value", () => {
    expect(resolveMatrixToken("t", {})).toBe("t");
    expect(resolveMatrixToken(null, { MATRIX_ACCESS_TOKEN: "x" })).toBeNull();
    expect(resolveMatrixToken(undefined, { MATRIX_ACCESS_TOKEN: "  x  " })).toBe("x");
    expect(resolveMatrixToken(undefined, { MATRIX_ACCESS_TOKEN: "   " })).toBeNull();
    expect(resolveMatrixToken(undefined, {})).toBeNull();
  });
});

describe("scrubMatrixError", () => {
  it("removes Synapse tokens, query tokens, bearer echoes and the known token", () => {
    const msg = scrubMatrixError(
      new Error(
        "bad syt_Ym90_abcdefghijklmnop_1a2b3c ?access_token=opaque123 Bearer zzz.yyy and secret-token-value",
      ),
      "secret-token-value",
    );
    expect(msg).not.toMatch(/syt_Ym90/);
    expect(msg).not.toMatch(/opaque123/);
    expect(msg).not.toMatch(/zzz\.yyy/);
    expect(msg).not.toMatch(/secret-token-value/);
    expect(msg.match(/<token>/g)?.length).toBe(4);
  });
});
