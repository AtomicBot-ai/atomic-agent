import { describe, expect, it, vi } from "vitest";

import { ModelError } from "../llm/reliability/llm-failures.js";
import { repeatedEmptyCompletionError } from "../agent/turn/empty-completion-recovery.js";
import { captureError } from "./error-reporter.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import type { SentryClient } from "./sentry-client.js";
import { isRepeatedEmptyAnswer } from "./repeated-empty-answer.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

const firstEmpty = () =>
  new ModelError("empty", "model returned empty content", {
    transport: "native_tools",
    stage: "initial",
  });

describe("isRepeatedEmptyAnswer (ATO-1676, CLI-R8)", () => {
  it("matches the error a turn ends with after the re-ask came back empty too", () => {
    expect(isRepeatedEmptyAnswer(repeatedEmptyCompletionError(firstEmpty()))).toBe(true);
    expect(
      isRepeatedEmptyAnswer(repeatedEmptyCompletionError(firstEmpty(), { cloud: true })),
    ).toBe(true);
  });

  it("matches it under a wrapper", () => {
    const wrapped = new Error("turn failed", { cause: repeatedEmptyCompletionError(firstEmpty()) });
    expect(isRepeatedEmptyAnswer(wrapped)).toBe(true);
  });

  it("leaves a single empty answer alone: no re-ask happened", () => {
    expect(isRepeatedEmptyAnswer(firstEmpty())).toBe(false);
  });

  it("leaves the grammar repair's empty alone: it can still be ours", () => {
    const repair = new ModelError("empty", "model returned empty content", {
      transport: "grammar",
      stage: "repair",
    });
    expect(isRepeatedEmptyAnswer(repair)).toBe(false);
  });

  it("leaves other model failures alone", () => {
    const cut = new ModelError("truncated", "cut", { cause: new ModelError("truncated", "cut") });
    expect(isRepeatedEmptyAnswer(cut)).toBe(false);
    expect(isRepeatedEmptyAnswer(new Error("boom"))).toBe(false);
    expect(isRepeatedEmptyAnswer("empty")).toBe(false);
    expect(isRepeatedEmptyAnswer(null)).toBe(false);
  });
});

describe("captureError and a repeated empty answer", () => {
  it("does not report it", () => {
    const { client, captured } = fakeClient();
    captureError(client, repeatedEmptyCompletionError(firstEmpty()), { source: "loop_failed", category: "model" });
    expect(captured).toHaveLength(0);
  });

  it("still reports a single empty answer and a repair-stage empty", () => {
    const { client, captured } = fakeClient();
    captureError(client, firstEmpty(), { source: "loop_failed", category: "model" });
    captureError(
      client,
      new ModelError("empty", "model returned empty content", { transport: "grammar", stage: "repair" }),
      { source: "loop_failed", category: "model" },
    );
    expect(captured).toHaveLength(2);
  });
});
