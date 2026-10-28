import { describe, expect, it, vi } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import type { LaunchRecord } from "../../local-llm/index.js";
import {
  capLocalContextGrowth,
  growLocalContext,
  planLocalContextGrowth,
  type LocalContextGrowthStep,
} from "./local-context-growth.js";

type Cfg = Parameters<typeof planLocalContextGrowth>[0];

function cfg(over: { mode?: "managed" | "external"; contextSize?: number; modelId?: string } = {}): Cfg {
  const local = USER_CONFIG_DEFAULTS.localModels;
  return {
    paths: { localModelsDataDir: "/data" },
    localModels: {
      ...local,
      mode: over.mode ?? "managed",
      completionMaxTokens: 16_384,
      managed: {
        ...local.managed,
        modelId: over.modelId ?? "qwen-3.8-27b",
        contextSize: over.contextSize ?? 0,
      },
    },
  } as unknown as Cfg;
}

function record(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    pid: 42,
    modelId: "qwen-3.8-27b",
    contextSize: 32_768,
    swaFull: false,
    prefixReuse: null,
    launchedAt: 1,
    autoContextCeiling: 262_144,
    ...over,
  };
}

describe("planLocalContextGrowth", () => {
  it("asks for one doubling once the last prompt passes three quarters of the prompt's room", () => {
    // 32,768 less the 16,384 reply reserve leaves 16,384; the trigger is past 12,288.
    expect(planLocalContextGrowth(cfg(), 12_000, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg(), 13_000, () => record())).toEqual({
      modelId: "qwen-3.8-27b",
      from: 32_768,
      to: 65_536,
      promptTokens: 13_000,
    });
  });

  it("stops at the ceiling the launch recorded", () => {
    expect(
      planLocalContextGrowth(cfg(), 30_000, () => record({ autoContextCeiling: 60_416 }))?.to,
    ).toBe(60_416);
    expect(
      planLocalContextGrowth(cfg(), 50_000, () => record({ contextSize: 60_416, autoContextCeiling: 60_416 })),
    ).toBeNull();
  });

  it("leaves a pinned context, external mode, a launch that does not grow and another model alone", () => {
    expect(planLocalContextGrowth(cfg({ contextSize: 131_072 }), 30_000, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg({ mode: "external" }), 30_000, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg(), 30_000, () => record({ autoContextCeiling: null }))).toBeNull();
    expect(planLocalContextGrowth(cfg(), 30_000, () => record({ autoContextCeiling: undefined }))).toBeNull();
    expect(planLocalContextGrowth(cfg({ modelId: "gemma-4-12b" }), 30_000, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg(), 30_000, () => null)).toBeNull();
  });

  it("does nothing without a measured prompt", () => {
    expect(planLocalContextGrowth(cfg(), null, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg(), undefined, () => record())).toBeNull();
    expect(planLocalContextGrowth(cfg(), 0, () => record())).toBeNull();
  });
});

describe("growLocalContext", () => {
  const STEP: LocalContextGrowthStep = { modelId: "qwen-3.8-27b", from: 32_768, to: 65_536, promptTokens: 13_000 };

  function deps(restartOk: boolean | Error) {
    const attempts: (number | null)[] = [];
    const seenAtRestart: (number | null)[] = [];
    let current: number | null = null;
    const d = {
      plan: vi.fn(() => STEP),
      setAttempt: vi.fn((n: number | null) => { attempts.push(n); current = n; }),
      commit: vi.fn(),
      restart: vi.fn(async () => {
        seenAtRestart.push(current);
        if (restartOk instanceof Error) throw restartOk;
        return restartOk;
      }),
      startAgain: vi.fn(async () => true),
      emit: vi.fn(),
    };
    return { d, attempts, seenAtRestart };
  }

  it("restarts with the bigger window and records it only once that start came up", async () => {
    const { d, attempts, seenAtRestart } = deps(true);
    await expect(growLocalContext(d)).resolves.toBe(true);
    expect(seenAtRestart).toEqual([65_536]);
    expect(attempts).toEqual([65_536, null]);
    expect(d.commit).toHaveBeenCalledWith(STEP);
    expect(d.startAgain).not.toHaveBeenCalled();
  });

  it("does not remember a size that failed, and starts the model again at the old window", async () => {
    for (const outcome of [false, new Error("load failed")]) {
      const { d, attempts } = deps(outcome);
      await expect(growLocalContext(d)).resolves.toBe(false);
      expect(d.commit).not.toHaveBeenCalled();
      // The attempt is cleared before the second start, which therefore asks for the committed window.
      expect(attempts).toEqual([65_536, null]);
      expect(d.startAgain).toHaveBeenCalledTimes(1);
      expect(d.setAttempt.mock.invocationCallOrder[1]!).toBeLessThan(d.startAgain.mock.invocationCallOrder[0]!);
    }
  });

  it("does nothing when there is no step to take", async () => {
    const { d } = deps(true);
    d.plan.mockReturnValue(null as unknown as LocalContextGrowthStep);
    await expect(growLocalContext(d)).resolves.toBe(false);
    expect(d.restart).not.toHaveBeenCalled();
    expect(d.setAttempt).not.toHaveBeenCalled();
  });
});

describe("capLocalContextGrowth (ATO-334 x ATO-848)", () => {
  const step: LocalContextGrowthStep = { modelId: "m", from: 32_768, to: 131_072, promptTokens: 30_000 };

  it("holds growth under the window an out-of-memory restart settled on", () => {
    expect(capLocalContextGrowth(step, { modelId: "m", atMost: 65_536 })).toEqual({ ...step, to: 65_536 });
    expect(capLocalContextGrowth({ ...step, from: 65_536 }, { modelId: "m", atMost: 65_536 })).toBeNull();
  });

  it("leaves other models, smaller steps and no ceiling alone", () => {
    expect(capLocalContextGrowth(step, { modelId: "other", atMost: 65_536 })).toBe(step);
    expect(capLocalContextGrowth({ ...step, to: 65_536 }, { modelId: "m", atMost: 65_536 })).toEqual({ ...step, to: 65_536 });
    expect(capLocalContextGrowth(step, null)).toBe(step);
    expect(capLocalContextGrowth(null, { modelId: "m", atMost: 65_536 })).toBeNull();
  });
});
