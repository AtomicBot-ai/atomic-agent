import { describe, expect, it } from "vitest";

import { isBrokenPipeError } from "./broken-pipe.js";

describe("isBrokenPipeError", () => {
  it("recognises a closed host pipe", () => {
    const err = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      syscall: "write",
    });
    expect(isBrokenPipeError(err)).toBe(true);
  });

  it("recognises a tty that went away", () => {
    const err = Object.assign(new Error("write EIO"), { code: "EIO" });
    expect(isBrokenPipeError(err)).toBe(true);
  });

  it("recognises a stream torn down under us", () => {
    for (const code of ["ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]) {
      expect(isBrokenPipeError(Object.assign(new Error(code), { code }))).toBe(
        true,
      );
    }
  });

  it("reads the code out of a cause chain", () => {
    const inner = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const outer = Object.assign(new Error("failed to emit event"), {
      cause: inner,
    });
    expect(isBrokenPipeError(outer)).toBe(true);
  });

  it("does not claim ordinary failures", () => {
    expect(isBrokenPipeError(new Error("boom"))).toBe(false);
    expect(
      isBrokenPipeError(Object.assign(new Error("x"), { code: "ECONNRESET" })),
    ).toBe(false);
    expect(isBrokenPipeError("EPIPE")).toBe(false);
    expect(isBrokenPipeError(null)).toBe(false);
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(isBrokenPipeError(err)).toBe(false);
  });
});
