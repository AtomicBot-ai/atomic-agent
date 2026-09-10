import { describe, expect, it } from "vitest";
import { ModelError, TransportError } from "../llm/index.js";
import type { TruncationDetail } from "../llm/index.js";
import {
  TRUNCATION_RETRY_CAP_CEILING,
  composeTruncationNotice,
  formatTruncationNotice,
  planTruncationRetry,
} from "./truncation-recovery.js";

function truncated(detail: Partial<TruncationDetail>): ModelError {
  return new ModelError("truncated", "model response truncated", {
    transport: "native_tools",
    stage: "initial",
    truncation: {
      cause: "reply_cap",
      completionTokens: 8_192,
      promptTokens: 6_000,
      requestedMaxTokens: 8_192,
      ...detail,
    },
  });
}

const BASE = {
  alreadyRetried: false,
  contextWindow: null,
  fallbackMaxTokens: 8_192,
  canFitWindow: true,
};

describe("planTruncationRetry", () => {
  it("raises the cap four-fold when the reply spent it", () => {
    const plan = planTruncationRetry({ ...BASE, error: truncated({}) });
    expect(plan?.retry).toEqual({ kind: "raise_cap", maxTokens: 32_768 });
  });

  it("never raises past the ceiling", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({
        requestedMaxTokens: 16_384,
        completionTokens: 16_384,
      }),
    });
    expect(plan?.retry).toEqual({
      kind: "raise_cap",
      maxTokens: TRUNCATION_RETRY_CAP_CEILING,
    });
  });

  it("stays under a known window", () => {
    // 20k window, 12k prompt: 4 × 4096 would be a 400 on a strict
    // provider and a silent clamp on llama.cpp. Leave headroom instead.
    const plan = planTruncationRetry({
      ...BASE,
      contextWindow: 20_000,
      error: truncated({
        requestedMaxTokens: 4_096,
        completionTokens: 4_096,
        promptTokens: 12_000,
      }),
    });
    expect(plan?.retry).toEqual({
      kind: "raise_cap",
      maxTokens: 20_000 - 12_000 - 512,
    });
  });

  it("plans nothing when the window leaves no room to raise", () => {
    const plan = planTruncationRetry({
      ...BASE,
      contextWindow: 15_000,
      error: truncated({
        requestedMaxTokens: 8_192,
        completionTokens: 8_192,
        promptTokens: 6_500,
      }),
    });
    expect(plan).toBeNull();
  });

  it("treats an unknown cause as the cap, using the fallback when the error carries none", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({
        cause: "unknown",
        completionTokens: 0,
        promptTokens: 0,
        requestedMaxTokens: 0,
      }),
    });
    expect(plan?.retry).toEqual({ kind: "raise_cap", maxTokens: 32_768 });
  });

  it("learns the window when the reply stopped short of the cap", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({
        cause: "context_window",
        completionTokens: 2_768,
        promptTokens: 30_000,
      }),
    });
    expect(plan?.retry).toEqual({ kind: "fit_window", contextWindow: 32_768 });
  });

  it("plans nothing for a window truncation when no one can record the window", () => {
    const plan = planTruncationRetry({
      ...BASE,
      canFitWindow: false,
      error: truncated({
        cause: "context_window",
        completionTokens: 2_768,
        promptTokens: 30_000,
      }),
    });
    expect(plan).toBeNull();
  });

  it("plans nothing for a provider's output limit — no request changes that", () => {
    const plan = planTruncationRetry({
      ...BASE,
      contextWindow: 131_072,
      error: truncated({
        cause: "output_limit",
        completionTokens: 4_096,
        promptTokens: 6_000,
      }),
    });
    expect(plan).toBeNull();
  });

  it("retries a step once", () => {
    expect(
      planTruncationRetry({
        ...BASE,
        alreadyRetried: true,
        error: truncated({}),
      }),
    ).toBeNull();
  });

  it("ignores every other failure", () => {
    expect(
      planTruncationRetry({
        ...BASE,
        error: new TransportError("fetch failed", null, ""),
      }),
    ).toBeNull();
    expect(
      planTruncationRetry({
        ...BASE,
        error: new ModelError("empty", "model returned empty content"),
      }),
    ).toBeNull();
    // A truncated ModelError from a caller that did not classify it.
    expect(
      planTruncationRetry({
        ...BASE,
        error: new ModelError("truncated", "model response truncated"),
      }),
    ).toBeNull();
  });
});

describe("truncation notice", () => {
  const detail: TruncationDetail = {
    cause: "reply_cap",
    completionTokens: 8_192,
    promptTokens: 6_000,
    requestedMaxTokens: 8_192,
  };

  it("tells the model its reply was cut and what the retry allows", () => {
    const notice = formatTruncationNotice(detail, {
      kind: "raise_cap",
      maxTokens: 32_768,
    });
    expect(notice).toContain("cut off after 8192 tokens");
    expect(notice).toContain("32768 tokens");
    expect(notice).toContain("Keep your reasoning brief");
  });

  it("explains the trimmed conversation on a window retry", () => {
    const notice = formatTruncationNotice(
      { ...detail, cause: "context_window" },
      { kind: "fit_window", contextWindow: 32_768 },
    );
    expect(notice).toContain("ran out of context");
    expect(notice).toContain("trimmed");
  });

  it("keeps whatever notice the step already carried, first", () => {
    const composed = composeTruncationNotice(
      "loop detector says stop",
      detail,
      {
        kind: "raise_cap",
        maxTokens: 32_768,
      },
    );
    expect(composed.startsWith("loop detector says stop\n\n")).toBe(true);
    expect(
      composeTruncationNotice(undefined, detail, {
        kind: "raise_cap",
        maxTokens: 1,
      }),
    ).not.toContain("\n\n");
  });
});
