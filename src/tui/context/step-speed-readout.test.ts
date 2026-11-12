import { describe, expect, it } from "vitest";
import { stepSpeedReadoutLabel } from "./step-speed-readout.js";

describe("stepSpeedReadoutLabel (ATO-631)", () => {
  it("takes no columns before a step has reported", () => {
    expect(stepSpeedReadoutLabel(null)).toBeNull();
    expect(stepSpeedReadoutLabel(undefined)).toBeNull();
  });

  it("reads speed, then how much of the prompt the cache served", () => {
    expect(
      stepSpeedReadoutLabel({
        decodeTokensPerSecond: 12.4,
        promptTokens: 12_000,
        cachedTokens: 11_040,
        prefillMs: 300,
        decodeMs: 4_000,
      }),
    ).toBe(" · 12 tok/s · cache 92%");
  });

  it("names a long re-read so a slow reply says why", () => {
    expect(
      stepSpeedReadoutLabel({
        decodeTokensPerSecond: 4.5,
        promptTokens: 32_000,
        cachedTokens: 2_000,
        prefillMs: 41_200,
        decodeMs: 2_000,
      }),
    ).toBe(" · 4.5 tok/s · cache 6% · read 30k in 41s");
  });
});
