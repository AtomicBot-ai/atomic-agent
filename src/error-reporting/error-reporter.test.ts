import { describe, expect, it, vi } from "vitest";

import { captureError } from "./error-reporter.js";
import type { SentryClient } from "./sentry-client.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

describe("captureError", () => {
  it("no-ops when the client is null", () => {
    expect(() =>
      captureError(null, new Error("x"), { source: "s" }),
    ).not.toThrow();
  });

  it("drops cancelled failures", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("aborted"), {
      name: "CancelledError",
      category: "cancelled",
    });
    captureError(client, err, { source: "llm_failure", category: "cancelled" });
    expect(captured).toHaveLength(0);
  });

  it("captures a real error via the scrubber", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("transport boom"), {
      name: "TransportError",
      category: "transport",
      status: 500,
    });
    captureError(client, err, { source: "llm_failure" });
    expect(captured).toHaveLength(1);
    expect(captured[0].errorType).toBe("TransportError");
    expect(captured[0].category).toBe("transport");
    expect(captured[0].message).toBeUndefined();
  });

  it("reports a non-Error thrown value as NonError without stringifying it", () => {
    const { client, captured } = fakeClient();
    // A thrown string could contain user data — it must never be sent.
    captureError(client, "/Users/alex/secret prompt text", { source: "uncaughtException" });
    expect(captured).toHaveLength(1);
    expect(captured[0].errorType).toBe("NonError");
    expect(captured[0].message).toBeUndefined();
  });
  it("drops a process-global broken pipe — the reader left, nothing broke", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("write EPIPE"), {
      code: "EPIPE",
      syscall: "write",
    });
    captureError(client, err, { source: "uncaughtException" });
    expect(captured).toHaveLength(0);
  });

  it("still reports an EPIPE raised at a call site, where it may be ours", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    captureError(client, err, { source: "tool_exec" });
    expect(captured).toHaveLength(1);
  });
});
