import { describe, expect, it } from "vitest";
import { GrammarError, ModelError } from "../llm/reliability/llm-failures.js";
import type { TruncationCause } from "../llm/reliability/failure-category.js";
import { extractAnswerFailureTags } from "./answer-failure-tag.js";
import { scrubError } from "./error-scrubber.js";
import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope } from "./sentry-envelope.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "0.6.12", platform: "darwin" };

function cut(cause: TruncationCause): ModelError {
  return new ModelError("truncated", "model response truncated at 16384 tokens: secret text", {
    transport: "grammar",
    stage: "initial",
    truncation: { cause, completionTokens: 16_384, promptTokens: 2_000 },
  });
}

function tagsOf(err: Error): Record<string, string> {
  const body = buildEnvelope(DSN, scrubError(err, { source: "llm_failure" }), META).body;
  return (JSON.parse(body.trim().split("\n")[2]!) as { tags: Record<string, string> }).tags;
}

describe("answer_failure / truncation_cause (ATO-1031)", () => {
  it("splits a cut at the limit from an empty answer and from a full window", () => {
    expect(extractAnswerFailureTags(cut("reply_cap"))).toEqual({
      answerFailure: "cut_at_limit",
      truncationCause: "reply_cap",
    });
    expect(extractAnswerFailureTags(cut("provider_limit")).answerFailure).toBe("cut_at_limit");
    expect(extractAnswerFailureTags(cut("context_window"))).toEqual({
      answerFailure: "context_full",
      truncationCause: "context_window",
    });
    expect(
      extractAnswerFailureTags(new ModelError("empty", "model returned empty content")),
    ).toEqual({ answerFailure: "empty_answer" });
    expect(
      extractAnswerFailureTags(new ModelError("no_stop", "no stop")),
    ).toEqual({ answerFailure: "no_stop" });
  });

  it("reads the model failure under a wrapper, and nothing off other errors", () => {
    const wrapped = new GrammarError("wrapped", "", { cause: cut("reply_cap") });
    expect(extractAnswerFailureTags(wrapped).answerFailure).toBe("cut_at_limit");
    expect(extractAnswerFailureTags(new Error("plain"))).toEqual({});
    // A look-alike field on a non-model error is not a model failure.
    expect(extractAnswerFailureTags(Object.assign(new Error("x"), { reason: "empty" }))).toEqual({});
  });

  it("puts distinct tags on the Sentry event, without the message", () => {
    const capTags = tagsOf(cut("reply_cap"));
    const emptyTags = tagsOf(new ModelError("empty", "model returned empty content"));
    expect(capTags.answer_failure).toBe("cut_at_limit");
    expect(capTags.truncation_cause).toBe("reply_cap");
    expect(emptyTags.answer_failure).toBe("empty_answer");
    expect(emptyTags.truncation_cause).toBeUndefined();
    expect(capTags.answer_failure).not.toBe(emptyTags.answer_failure);
    const body = buildEnvelope(DSN, scrubError(cut("reply_cap"), { source: "llm_failure" }), META).body;
    expect(body).not.toContain("secret text");
  });
});
