import { describe, expect, it } from "vitest";

import { coreLoadOverrides } from "./core-sessions.js";
import { coreMtpSwitch, coreSpeculativeSupport } from "./core-speculative.js";

describe("Core speculative decoding support (ATO-452)", () => {
  it("never turns MTP on for the TurboQuant chat provider, which Core clears", () => {
    expect(coreSpeculativeSupport("llamacpp")).toEqual({ mtp: false, dflash: false });
    expect(coreMtpSwitch("llamacpp", true)).toBe(false);
  });

  it("allows MTP on upstream llama.cpp only for a model with a head", () => {
    expect(coreMtpSwitch("llamacpp-upstream", true)).toBe(true);
    expect(coreMtpSwitch("llamacpp-upstream", false)).toBe(false);
    expect(coreSpeculativeSupport("llamacpp-upstream").dflash).toBe(false);
  });

  it("treats an unknown provider as unsupported", () => {
    expect(coreSpeculativeSupport("mlx")).toEqual({ mtp: false, dflash: false });
    expect(coreMtpSwitch("mlx", true)).toBe(false);
  });

  it("keeps the Core load switches off by default", () => {
    expect(coreLoadOverrides(["--ctx-size", "8192"])).toMatchObject({ mtp: false, dflash: false });
    expect(coreLoadOverrides(["--ctx-size", "8192"], { mtp: true })).toMatchObject({ mtp: true, dflash: false });
  });
});
