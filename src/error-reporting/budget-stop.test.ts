import { describe, expect, it, vi } from "vitest";

import { RequestTooLargeError } from "../llm/reliability/request-too-large.js";
import { FusionBudgetStopError } from "../tools/fusion/turn-budget-stop-error.js";
import { isBudgetStopError } from "./budget-stop.js";
import { captureError } from "./error-reporter.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";
import type { SentryClient } from "./sentry-client.js";

function fakeClient() {
  const captured: ScrubbedErrorEvent[] = [];
  const client = {
    capture: vi.fn((ev: ScrubbedErrorEvent) => captured.push(ev)),
  } as unknown as SentryClient;
  return { client, captured };
}

const stop = (kind: "usd" | "time") =>
  new FusionBudgetStopError({
    kind,
    message:
      kind === "usd"
        ? "the spend cap for this turn is reached: $2.50 of the $2.00 cap"
        : "the time cap for this turn is reached: 31 min of the 30 min cap",
    spentUsd: 2.5,
    elapsedMs: 31 * 60_000,
  });

/** The four shapes the Sentry issues (CLI-P9/PG, PK/PE, PW, PP) arrived in. */
const BUDGET_SHAPES: Array<[string, () => unknown]> = [
  // CLI-P9/PG: the time cap's timer fires and aborts the workers.
  ["the abort reason itself (time cap timer)", () => stop("time")],
  // CLI-PK/PE: the spend cap stops the run from a usage callback.
  [
    "wrapped as the cause of an LLM failure",
    () => Object.assign(new Error("worker failed"), { name: "TransportError", cause: stop("usd") }),
  ],
  // CLI-PW: a request refused before it left, its AbortError carrying the stop.
  [
    "an AbortError whose cause is the stop",
    () => Object.assign(new Error("This operation was aborted"), { name: "AbortError", cause: stop("usd") }),
  ],
  // CLI-PP: a RequestTooLargeError raised while the cap was cutting the run.
  [
    "a RequestTooLargeError whose cause chain holds the stop",
    () =>
      new RequestTooLargeError("The request does not fit.", null, {
        cause: Object.assign(new Error("aborted"), { name: "AbortError", cause: stop("time") }),
      }),
  ],
];

describe("isBudgetStopError (ATO-1677)", () => {
  it.each(BUDGET_SHAPES)("matches %s", (_label, make) => {
    expect(isBudgetStopError(make())).toBe(true);
  });

  it("does not match a real context overflow", () => {
    const overflow = new RequestTooLargeError(
      "The request does not fit the model's context window (8192 tokens).",
      8192,
      { cause: Object.assign(new Error("exceed_context_size_error"), { name: "LlamaServerError" }) },
    );
    expect(isBudgetStopError(overflow)).toBe(false);
  });

  it("does not match a plain Error carrying the cap's words", () => {
    expect(
      isBudgetStopError(new Error("the spend cap for this turn is reached")),
    ).toBe(false);
  });

  it("does not match non-errors or a cause cycle", () => {
    expect(isBudgetStopError(undefined)).toBe(false);
    expect(isBudgetStopError("FusionBudgetStopError")).toBe(false);
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isBudgetStopError(a)).toBe(false);
  });
});

describe("captureError drops budget stops (ATO-1677)", () => {
  it.each(BUDGET_SHAPES)("drops %s", (_label, make) => {
    const { client, captured } = fakeClient();
    captureError(client, make(), { source: "llm_failure", category: "transport" });
    captureError(client, make(), { source: "unhandledRejection" });
    expect(captured).toHaveLength(0);
  });

  it("still reports a real RequestTooLargeError", () => {
    const { client, captured } = fakeClient();
    const overflow = new RequestTooLargeError(
      "The request does not fit the model's context window (8192 tokens).",
      8192,
    );
    captureError(client, overflow, { source: "llm_failure", category: "grammar" });
    expect(captured).toHaveLength(1);
  });

  it("still reports an unrelated Error", () => {
    const { client, captured } = fakeClient();
    captureError(client, new Error("boom"), { source: "llm_failure", category: "transport" });
    expect(captured).toHaveLength(1);
  });
});
