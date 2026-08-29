import { describe, it, expect } from "vitest";
import { isNetworkError, readNetworkErrorCode } from "./network-error.js";

/** The shape undici throws from `fetch` when the connection fails. */
function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("readNetworkErrorCode", () => {
  it("reads a connection errno off the error itself", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(readNetworkErrorCode(err)).toBe("ECONNREFUSED");
  });

  it("reads the errno out of undici's cause chain", () => {
    const inner = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    expect(readNetworkErrorCode(fetchFailed(inner))).toBe("ECONNRESET");
  });

  it("accepts undici's own UND_ERR_* codes", () => {
    const inner = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    });
    expect(readNetworkErrorCode(fetchFailed(inner))).toBe("UND_ERR_SOCKET");
  });

  it("ignores stdio errnos — a broken local pipe is not an upstream failure", () => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(readNetworkErrorCode(err)).toBeUndefined();
    const eio = Object.assign(new Error("write EIO"), { code: "EIO" });
    expect(readNetworkErrorCode(eio)).toBeUndefined();
  });

  it("ignores unrelated codes and non-errors", () => {
    expect(
      readNetworkErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })),
    ).toBeUndefined();
    expect(readNetworkErrorCode("boom")).toBeUndefined();
    expect(readNetworkErrorCode(null)).toBeUndefined();
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(readNetworkErrorCode(err)).toBeUndefined();
  });
});

describe("isNetworkError", () => {
  it("recognises a bare `fetch failed` with no errno anywhere", () => {
    expect(isNetworkError(new TypeError("fetch failed"))).toBe(true);
  });

  it("recognises undici's socket messages", () => {
    expect(isNetworkError(new Error("terminated"))).toBe(true);
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
    expect(isNetworkError(fetchFailed(new Error("other side closed")))).toBe(
      true,
    );
  });

  it("recognises an errno carried anywhere in the chain", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), {
      code: "ECONNREFUSED",
    });
    expect(isNetworkError(fetchFailed(inner))).toBe(true);
  });

  it("does not claim ordinary runtime bugs", () => {
    expect(isNetworkError(new TypeError("x.map is not a function"))).toBe(false);
    expect(isNetworkError(new Error("tool crashed"))).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
