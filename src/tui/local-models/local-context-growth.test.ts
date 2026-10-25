import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import type { LaunchRecord } from "../../local-llm/index.js";
import { planLocalContextGrowth } from "./local-context-growth.js";

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
