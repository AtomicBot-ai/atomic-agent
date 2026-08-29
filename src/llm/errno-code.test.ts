import { describe, expect, it } from "vitest";

import { readErrnoCode } from "./errno-code.js";

describe("readErrnoCode", () => {
  it("reads the errno off the error itself", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), {
      code: "ECONNREFUSED",
    });
    expect(readErrnoCode(err)).toBe("ECONNREFUSED");
  });

  it("digs the errno out from under undici's `fetch failed`", () => {
    const inner = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const outer = Object.assign(new TypeError("fetch failed"), {
      cause: inner,
    });
    expect(readErrnoCode(outer)).toBe("ECONNRESET");
  });

  it("accepts undici's own UND_ERR_* codes", () => {
    const inner = Object.assign(new Error("other side closed"), {
      code: "UND_ERR_SOCKET",
    });
    expect(
      readErrnoCode(Object.assign(new TypeError("fetch failed"), { cause: inner })),
    ).toBe("UND_ERR_SOCKET");
  });

  it("drops a freeform code — it could carry user data", () => {
    const err = Object.assign(new Error("x"), {
      code: "failed to read /home/alex/notes.md",
    });
    expect(readErrnoCode(err)).toBeUndefined();
  });

  it("returns undefined for errors with no code and for non-objects", () => {
    expect(readErrnoCode(new Error("plain"))).toBeUndefined();
    expect(readErrnoCode("ECONNREFUSED")).toBeUndefined();
    expect(readErrnoCode(null)).toBeUndefined();
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(readErrnoCode(err)).toBeUndefined();
  });
});
