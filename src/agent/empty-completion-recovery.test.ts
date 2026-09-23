import { describe, it, expect } from "vitest";
import { ModelError } from "../llm/reliability/llm-failures.js";
import { GrammarError } from "../llm/reliability/llm-failures.js";
import {
  EMPTY_COMPLETION_RECOVERY_BUDGET,
  composeEmptyCompletionNotice,
  formatEmptyCompletionNotice,
  isRecoverableEmptyCompletion,
  repeatedEmptyCompletionError,
} from "./empty-completion-recovery.js";

function emptyOn(
  transport: "grammar" | "native_tools",
  stage: "initial" | "repair",
): ModelError {
  return new ModelError("empty", "model returned an empty completion", {
    transport,
    stage,
  });
}

describe("isRecoverableEmptyCompletion", () => {
  it("accepts a wholly empty native_tools completion at the initial stage", () => {
    expect(
      isRecoverableEmptyCompletion(emptyOn("native_tools", "initial")),
    ).toBe(true);
  });

  it("rejects the grammar transport, which has its own in-step repair", () => {
    expect(isRecoverableEmptyCompletion(emptyOn("grammar", "initial"))).toBe(
      false,
    );
  });

  it("rejects the repair stage, which has already had its extra attempt", () => {
    expect(
      isRecoverableEmptyCompletion(emptyOn("native_tools", "repair")),
    ).toBe(false);
  });

  it("rejects truncated and no_stop, which a second pass cannot fix", () => {
    for (const reason of ["truncated", "no_stop"] as const) {
      expect(
        isRecoverableEmptyCompletion(
          new ModelError(reason, "cut off", {
            transport: "native_tools",
            stage: "initial",
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects an untagged ModelError and everything that is not one", () => {
    expect(isRecoverableEmptyCompletion(new ModelError("empty", "x"))).toBe(
      false,
    );
    expect(isRecoverableEmptyCompletion(new GrammarError("bad", ""))).toBe(
      false,
    );
    expect(isRecoverableEmptyCompletion(new Error("nope"))).toBe(false);
    expect(isRecoverableEmptyCompletion("not an error")).toBe(false);
  });
});

describe("formatEmptyCompletionNotice", () => {
  it("says what came back, that nothing ran, and what to do", () => {
    const notice = formatEmptyCompletionNotice();
    expect(notice).toContain("completely empty");
    expect(notice).toContain("Nothing has happened yet");
    expect(notice).toContain("Answer this step now");
  });
});

describe("composeEmptyCompletionNotice", () => {
  it("returns the block alone when the step owed nothing", () => {
    expect(composeEmptyCompletionNotice(undefined)).toBe(
      formatEmptyCompletionNotice(),
    );
    expect(composeEmptyCompletionNotice("")).toBe(
      formatEmptyCompletionNotice(),
    );
  });

  it("puts the empty-reply block first, ahead of the notice already owed", () => {
    const composed = composeEmptyCompletionNotice("stop re-reading that file");
    expect(composed.startsWith(formatEmptyCompletionNotice())).toBe(true);
    expect(composed).toContain("stop re-reading that file");
  });
});

describe("repeatedEmptyCompletionError", () => {
  it("says the model returned nothing twice and keeps the diagnostic tags", () => {
    const first = emptyOn("native_tools", "initial");
    const repeated = repeatedEmptyCompletionError(first);
    expect(repeated).toBeInstanceOf(ModelError);
    expect(repeated.message).toContain("twice in a row");
    expect(repeated.message).toContain(first.message);
    expect(repeated.reason).toBe("empty");
    expect(repeated.transport).toBe("native_tools");
    expect(repeated.stage).toBe("initial");
    expect(repeated.category).toBe("model");
    expect(repeated.cause).toBe(first);
  });
});

describe("EMPTY_COMPLETION_RECOVERY_BUDGET", () => {
  it("buys exactly one retry, so the second empty is terminal", () => {
    expect(EMPTY_COMPLETION_RECOVERY_BUDGET).toBe(1);
  });
});
