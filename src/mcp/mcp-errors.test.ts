import { describe, expect, it } from "vitest";

import {
  McpConnectError,
  McpError,
  McpRequestError,
  scrubErrorMessage,
} from "./mcp-errors.js";

describe("McpError hierarchy", () => {
  it("McpError carries server + message", () => {
    const err = new McpError("github", "boom");
    expect(err.server).toBe("github");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("McpError");
    expect(err).toBeInstanceOf(Error);
  });

  it("McpConnectError is an McpError with the right name", () => {
    const err = new McpConnectError("github", "connection refused");
    expect(err.name).toBe("McpConnectError");
    expect(err).toBeInstanceOf(McpError);
    expect(err.server).toBe("github");
  });

  it("McpRequestError carries operation and is an McpError", () => {
    const err = new McpRequestError("github", "tools/call", "isError true");
    expect(err.name).toBe("McpRequestError");
    expect(err.operation).toBe("tools/call");
    expect(err).toBeInstanceOf(McpError);
  });
});

describe("scrubErrorMessage", () => {
  it("returns `(no error)` for null and undefined", () => {
    expect(scrubErrorMessage(null)).toBe("(no error)");
    expect(scrubErrorMessage(undefined)).toBe("(no error)");
  });

  it("strips the leading `Error:` prefix", () => {
    expect(scrubErrorMessage(new Error("connection refused"))).toBe(
      "connection refused",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(scrubErrorMessage("   hi there  ")).toBe("hi there");
  });

  it("clips long messages to the configured max length", () => {
    const longMsg = "a".repeat(500);
    const out = scrubErrorMessage(longMsg, 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("coerces non-Error inputs through String()", () => {
    expect(scrubErrorMessage({ toString: () => "boom" })).toBe("boom");
  });

  it("uses default max length of 200", () => {
    const longMsg = "x".repeat(500);
    expect(scrubErrorMessage(longMsg).length).toBe(200);
  });
});
