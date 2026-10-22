import { describe, expect, it } from "vitest";
import { ModelError, TransportError } from "../../llm/index.js";
import type { TruncationDetail } from "../../llm/index.js";
import {
  TRUNCATION_RETRY_CAP_CEILING,
  TRUNCATION_RETRY_TURN_BUDGET,
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
  stepAttempts: 0,
  turnAttempts: 0,
  modelMode: "local" as const,
  contextWindow: null,
  fallbackMaxTokens: 8_192,
  canFitWindow: true,
};

describe("planTruncationRetry", () => {
  it("raises a local cap two-fold when the reply spent it", () => {
    const plan = planTruncationRetry({ ...BASE, error: truncated({}) });
    expect(plan?.retry).toEqual({ kind: "raise_cap", maxTokens: 16_384 });
  });

  it("raises a local 16k cut to 32k, not four-fold", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({ requestedMaxTokens: 16_384, completionTokens: 16_384 }),
    });
    expect(plan?.retry).toEqual({ kind: "raise_cap", maxTokens: 32_768 });
  });

  it("keeps a local cap when the cut reply was a loop", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({
        requestedMaxTokens: 16_384,
        completionTokens: 16_384,
        repetitive: true,
      }),
    });
    expect(plan?.retry).toEqual({ kind: "same_cap", maxTokens: 16_384 });
  });

  it("retries a local step once", () => {
    expect(
      planTruncationRetry({ ...BASE, stepAttempts: 1, error: truncated({}) }),
    ).toBeNull();
  });

  it("holds the cap on cloud, even one past the ceiling", () => {
    // The live case (ATO-780): 64000 cap, a 64000-token reply. The old
    // four-fold raise clamped to 32768, which is not a raise, so the
    // turn failed on the first cut.
    const plan = planTruncationRetry({
      ...BASE,
      modelMode: "cloud",
      error: truncated({ requestedMaxTokens: 64_000, completionTokens: 64_000 }),
    });
    expect(plan?.retry).toEqual({ kind: "same_cap", maxTokens: 64_000 });
  });

  it("does not raise a cloud cap that has room to grow", () => {
    const plan = planTruncationRetry({
      ...BASE,
      modelMode: "cloud",
      error: truncated({ requestedMaxTokens: 16_384, completionTokens: 16_384 }),
    });
    expect(plan?.retry).toEqual({ kind: "same_cap", maxTokens: 16_384 });
  });

  it("retries a cloud step twice, then plans nothing", () => {
    const cloud = { ...BASE, modelMode: "cloud" as const, error: truncated({}) };
    expect(planTruncationRetry({ ...cloud, stepAttempts: 1 })?.retry).toEqual({
      kind: "same_cap",
      maxTokens: 8_192,
    });
    expect(planTruncationRetry({ ...cloud, stepAttempts: 2 })).toBeNull();
  });

  it("stops once the turn's budget is spent, in either mode", () => {
    for (const modelMode of ["local", "cloud"] as const) {
      expect(
        planTruncationRetry({
          ...BASE,
          modelMode,
          turnAttempts: TRUNCATION_RETRY_TURN_BUDGET,
          error: truncated({}),
        }),
      ).toBeNull();
    }
  });

  it("caps a cloud no-cap cut at what the provider delivered", () => {
    const plan = planTruncationRetry({
      ...BASE,
      modelMode: "cloud",
      error: truncated({
        cause: "provider_limit",
        completionTokens: 33_678,
        promptTokens: 21_000,
        requestedMaxTokens: undefined,
      }),
    });
    expect(plan?.retry).toEqual({ kind: "same_cap", maxTokens: 33_678 });
  });

  it("never raises past the ceiling, and holds a cap already at it", () => {
    const plan = planTruncationRetry({
      ...BASE,
      error: truncated({
        requestedMaxTokens: 24_000,
        completionTokens: 24_000,
      }),
    });
    expect(plan?.retry).toEqual({
      kind: "raise_cap",
      maxTokens: TRUNCATION_RETRY_CAP_CEILING,
    });
    const atCeiling = planTruncationRetry({
      ...BASE,
      error: truncated({
        requestedMaxTokens: TRUNCATION_RETRY_CAP_CEILING,
        completionTokens: TRUNCATION_RETRY_CAP_CEILING,
      }),
    });
    expect(atCeiling?.retry).toEqual({
      kind: "same_cap",
      maxTokens: TRUNCATION_RETRY_CAP_CEILING,
    });
  });

  it("stays under a known window", () => {
    // 16k window, 9k prompt: 2 × 4096 would be a 400 on a strict
    // provider and a silent clamp on llama.cpp. Leave headroom instead.
    const plan = planTruncationRetry({
      ...BASE,
      contextWindow: 16_000,
      error: truncated({
        requestedMaxTokens: 4_096,
        completionTokens: 4_096,
        promptTokens: 9_000,
      }),
    });
    expect(plan?.retry).toEqual({
      kind: "raise_cap",
      maxTokens: 16_000 - 9_000 - 512,
    });
  });

  it("holds the cap, inside the window, when the window leaves no room to raise", () => {
    const plan = planTruncationRetry({
      ...BASE,
      contextWindow: 15_000,
      error: truncated({
        requestedMaxTokens: 8_192,
        completionTokens: 8_192,
        promptTokens: 6_500,
      }),
    });
    expect(plan?.retry).toEqual({
      kind: "same_cap",
      maxTokens: 15_000 - 6_500 - 512,
    });
    const full = planTruncationRetry({
      ...BASE,
      contextWindow: 7_000,
      error: truncated({ promptTokens: 6_600 }),
    });
    expect(full).toBeNull();
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
    expect(plan?.retry).toEqual({ kind: "raise_cap", maxTokens: 16_384 });
  });

  it("sends a raised cap on local when the provider stopped at its own limit with none on the wire", () => {
    // No cap sent: the fallback cap, raised two-fold.
    const plan = planTruncationRetry({
      ...BASE,
      fallbackMaxTokens: 16_384,
      error: truncated({
        cause: "provider_limit",
        completionTokens: 33_678,
        promptTokens: 21_000,
        requestedMaxTokens: undefined,
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

  it("caps the retry at a provider's output limit, in either mode", () => {
    // ATO-793: 64000 asked, the provider stopped at 32000.
    for (const modelMode of ["local", "cloud"] as const) {
      const plan = planTruncationRetry({
        ...BASE,
        modelMode,
        contextWindow: 200_000,
        error: truncated({
          cause: "output_limit",
          requestedMaxTokens: 64_000,
          completionTokens: 32_000,
          promptTokens: 6_000,
        }),
      });
      expect(plan?.retry).toEqual({ kind: "same_cap", maxTokens: 32_000 });
    }
  });

  it("learns the window once per step, even on cloud", () => {
    const plan = planTruncationRetry({
      ...BASE,
      modelMode: "cloud",
      stepAttempts: 1,
      error: truncated({
        cause: "context_window",
        completionTokens: 2_768,
        promptTokens: 30_000,
      }),
    });
    expect(plan).toBeNull();
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
    expect(notice).toContain("write it in parts");
  });

  it("asks for less and for a large file in parts when the cap is held", () => {
    const notice = formatTruncationNotice(
      { ...detail, completionTokens: 64_000, requestedMaxTokens: 64_000 },
      { kind: "same_cap", maxTokens: 64_000 },
    );
    expect(notice).toContain("cut off after 64000 tokens");
    expect(notice).toContain("stays at 64000 tokens");
    expect(notice).toContain("Think less");
    expect(notice).toContain("write it in parts");
    expect(notice).toContain('mode "append"');
    expect(notice).not.toContain("repeating");
    expect(notice).not.toContain("\u2014");
  });

  it("names the loop when the held cap follows a repetitive reply", () => {
    const notice = formatTruncationNotice(
      { ...detail, repetitive: true },
      { kind: "same_cap", maxTokens: 8_192 },
    );
    expect(notice).toContain("repeating the same text");
    expect(notice).toContain("write it in parts");
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
