import { describe, expect, it, vi } from "vitest";

import { RequestTooLargeError } from "../llm/reliability/request-too-large.js";
import type { StepContext } from "../agent/step/step-contract.js";
import { toLlmFailure } from "../agent/step/step-errors.js";
import { ToolExecutionError } from "../llm/reliability/llm-failures.js";
import {
  FusionBudgetStopError,
  FusionWorkerStopError,
  type FusionWorkerStopReason,
} from "../tools/fusion/fusion-stop-errors.js";
import { isFusionStopError } from "./fusion-stop.js";
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

const personStop = () =>
  new FusionWorkerStopError("person", "stopped by the person");

/**
 * Generic shapes: the stop on its own and anywhere down a `cause` chain.
 * The production shape is the `toLlmFailure` block below.
 */
const STOP_SHAPES: Array<[string, () => unknown]> = [
  ["a budget stop on its own", () => stop("time")],
  ["a worker stop on its own", () => personStop()],
  [
    "a budget stop as the cause of a wrapper",
    () => Object.assign(new Error("worker failed"), { name: "TransportError", cause: stop("usd") }),
  ],
  [
    "a worker stop two causes down",
    () =>
      Object.assign(new Error("outer"), {
        cause: Object.assign(new Error("aborted"), { name: "AbortError", cause: personStop() }),
      }),
  ],
];

describe("isFusionStopError (ATO-1677)", () => {
  it.each(STOP_SHAPES)("matches %s", (_label, make) => {
    expect(isFusionStopError(make())).toBe(true);
  });

  it("does not match a real context overflow", () => {
    const overflow = new RequestTooLargeError(
      "The request does not fit the model's context window (8192 tokens).",
      8192,
      { cause: Object.assign(new Error("exceed_context_size_error"), { name: "LlamaServerError" }) },
    );
    expect(isFusionStopError(overflow)).toBe(false);
  });

  it("does not match a plain Error carrying the cap's words", () => {
    expect(
      isFusionStopError(new Error("the spend cap for this turn is reached")),
    ).toBe(false);
  });

  it("does not match non-errors or a cause cycle", () => {
    expect(isFusionStopError(undefined)).toBe(false);
    expect(isFusionStopError("FusionBudgetStopError")).toBe(false);
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isFusionStopError(a)).toBe(false);
  });
});

describe("captureError drops budget stops (ATO-1677)", () => {
  it.each(STOP_SHAPES)("drops %s", (_label, make) => {
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

/**
 * The shape that reached Sentry (CLI-P9/PG `stopForBudget`, CLI-PK/PE
 * `Object.stop`): the worker's request rejects with its signal's reason
 * as is (`cancellationError` in openai-provider.ts), the step's signal is
 * aborted, `classifyFailure` reads the reason as `tool`, so
 * `toLlmFailure` files it as a `ToolExecutionError` whose `cause` is the
 * stop, and the loop's `loop_failed` hands that to `captureError`.
 */
describe("a stopped worker's step failure is not reported (ATO-1677)", () => {
  const failureOf = (reason: Error) => {
    const controller = new AbortController();
    controller.abort(reason);
    const ctx = { signal: controller.signal } as unknown as StepContext;
    return toLlmFailure(controller.signal.reason, ctx);
  };

  const reasons: Array<[string, () => Error]> = [
    ["the time cap (stopForBudget)", () => stop("time")],
    ["the spend cap (stopForBudget)", () => stop("usd")],
    ...(
      [
        ["person", "stopped by the person"],
        ["replaced", "replaced by the escalation model"],
        ["hand-back", "handed back early: no file written by half the budget"],
        ["time-limit", "time limit"],
        ["escalation-cap", "escalation cap"],
      ] as Array<[FusionWorkerStopReason, string]>
    ).map(
      ([reason, message]): [string, () => Error] => [
        `the worker stop "${reason}"`,
        () => new FusionWorkerStopError(reason, message),
      ],
    ),
  ];

  it.each(reasons)("drops %s", (_label, make) => {
    const stopError = make();
    const failure = failureOf(stopError);
    // Classification is unchanged: still a tool failure carrying the stop.
    expect(failure).toBeInstanceOf(ToolExecutionError);
    expect(failure.message).toBe(stopError.message);
    expect((failure as { cause?: unknown }).cause).toBe(stopError);
    const { client, captured } = fakeClient();
    captureError(client, failure, { source: "llm_failure", category: failure.category });
    expect(captured).toHaveLength(0);
  });

  it("still reports a plain Error abort reason (the shape before the fix)", () => {
    const failure = failureOf(new Error("stopped by the person"));
    const { client, captured } = fakeClient();
    captureError(client, failure, { source: "llm_failure", category: failure.category });
    expect(captured).toHaveLength(1);
  });
});
