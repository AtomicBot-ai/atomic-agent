import { describe, expect, it } from "vitest";

import {
  cacheHitShare,
  draftAcceptanceShare,
  formatStepSpeedParts,
  stepSpeedFromCompletion,
} from "./step-speed.js";

/**
 * ATO-631: a slow reply should say why. "re-reading 30k tokens" and
 * "writing 12 tok/s" are different problems with different fixes.
 */
describe("stepSpeedFromCompletion", () => {
  it("takes the rate the server stated", () => {
    const speed = stepSpeedFromCompletion({
      timing: {
        promptMs: 500,
        predictedMs: 4_000,
        promptTokens: 12_000,
        predictedTokens: 48,
        predictedPerSecond: 12.4,
      },
      cacheHitTokens: 11_000,
    });
    expect(speed?.decodeTokensPerSecond).toBe(12.4);
    expect(speed?.promptTokens).toBe(12_000);
    expect(speed?.cachedTokens).toBe(11_000);
    expect(speed?.prefillMs).toBe(500);
    expect(speed?.decodeMs).toBe(4_000);
  });

  it("derives the rate from count and duration on an older server", () => {
    const speed = stepSpeedFromCompletion({
      timing: {
        promptMs: 0,
        predictedMs: 10_000,
        promptTokens: 100,
        predictedTokens: 200,
      },
      cacheHitTokens: 0,
    });
    expect(speed?.decodeTokensPerSecond).toBe(20);
  });

  it("claims no rate for a cloud completion with no millisecond split", () => {
    const speed = stepSpeedFromCompletion({
      timing: { promptMs: 0, predictedMs: 0, promptTokens: 900, predictedTokens: 50 },
      cacheHitTokens: 300,
    });
    expect(speed?.decodeTokensPerSecond).toBeNull();
    expect(formatStepSpeedParts(speed)).toEqual(["cache 33%"]);
  });

  it("is null when the completion reported nothing", () => {
    expect(stepSpeedFromCompletion({})).toBeNull();
    expect(
      stepSpeedFromCompletion({
        timing: { promptMs: 0, predictedMs: 0, promptTokens: 0, predictedTokens: 0 },
      }),
    ).toBeNull();
  });

  it("never reports more cached tokens than the prompt had", () => {
    const speed = stepSpeedFromCompletion({
      timing: { promptMs: 0, predictedMs: 0, promptTokens: 10, predictedTokens: 1 },
      cacheHitTokens: 50,
    });
    expect(speed && cacheHitShare(speed)).toBe(1);
  });

  it("keeps the draft counts only when a draft model ran", () => {
    const withDraft = stepSpeedFromCompletion({
      timing: {
        promptMs: 0,
        predictedMs: 1_000,
        promptTokens: 10,
        predictedTokens: 30,
        draftTokens: 40,
        draftAcceptedTokens: 28,
      },
    });
    expect(withDraft && draftAcceptanceShare(withDraft)).toBe(0.7);
    const without = stepSpeedFromCompletion({
      timing: { promptMs: 0, predictedMs: 1_000, promptTokens: 10, predictedTokens: 30 },
    });
    expect(without?.draftTokens).toBeUndefined();
    expect(without && draftAcceptanceShare(without)).toBeNull();
  });
});

describe("formatStepSpeedParts", () => {
  it("says speed and cache share on a warm, quick step", () => {
    const speed = stepSpeedFromCompletion({
      timing: {
        promptMs: 300,
        predictedMs: 4_000,
        promptTokens: 12_000,
        predictedTokens: 48,
        predictedPerSecond: 12.4,
      },
      cacheHitTokens: 11_040,
    });
    expect(formatStepSpeedParts(speed)).toEqual(["12 tok/s", "cache 92%"]);
  });

  it("names the re-read when prefill was the slow part", () => {
    const speed = stepSpeedFromCompletion({
      timing: {
        promptMs: 41_200,
        predictedMs: 2_000,
        promptTokens: 32_000,
        predictedTokens: 9,
        predictedPerSecond: 4.5,
      },
      cacheHitTokens: 2_000,
    });
    expect(formatStepSpeedParts(speed)).toEqual([
      "4.5 tok/s",
      "cache 6%",
      "read 30k in 41s",
    ]);
  });

  it("adds draft acceptance under speculative decoding", () => {
    const speed = stepSpeedFromCompletion({
      timing: {
        promptMs: 100,
        predictedMs: 1_000,
        promptTokens: 1_000,
        predictedTokens: 40,
        predictedPerSecond: 40,
        draftTokens: 50,
        draftAcceptedTokens: 35,
      },
      cacheHitTokens: 1_000,
    });
    expect(formatStepSpeedParts(speed)).toEqual([
      "40 tok/s",
      "cache 100%",
      "draft 70%",
    ]);
  });

  it("prints minutes for a very long prefill", () => {
    const speed = stepSpeedFromCompletion({
      timing: { promptMs: 119_600, predictedMs: 0, promptTokens: 6_448, predictedTokens: 0 },
      cacheHitTokens: 0,
    });
    expect(formatStepSpeedParts(speed)).toEqual(["cache 0%", "read 6.4k in 2m00s"]);
  });

  it("is empty with nothing to say", () => {
    expect(formatStepSpeedParts(null)).toEqual([]);
  });
});
