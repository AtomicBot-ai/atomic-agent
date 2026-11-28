import { describe, expect, it, vi } from "vitest";

import { ContextWindowTooSmallError } from "../llm/reliability/context-window-too-small.js";
import { captureError } from "./error-reporter.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import type { SentryClient } from "./sentry-client.js";

/**
 * ATO-1678: a window too small for the instructions and tool schemas is
 * the person's to fix (a bigger context, fewer tools), and the chat says
 * so. It is not a defect, so it does not reach error reporting.
 */

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

describe("captureError and a context window too small for the tools", () => {
  it("drops it, also when wrapped", () => {
    const { client, captured } = fakeClient();
    const err = new ContextWindowTooSmallError(16_384, 15_800, 12_000);
    captureError(client, err, { source: "llm_failure", category: "grammar" });
    captureError(client, new Error("turn failed", { cause: err }), {
      source: "llm_failure",
      category: "grammar",
    });
    expect(captured).toHaveLength(0);
  });

  it("still reports a real context overflow from the server", () => {
    const { client, captured } = fakeClient();
    const err = Object.assign(new Error("context full"), {
      name: "RequestTooLargeError",
      category: "grammar",
    });
    captureError(client, err, { source: "llm_failure", category: "grammar" });
    expect(captured).toHaveLength(1);
  });
});
