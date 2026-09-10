import { describe, expect, it } from "vitest";

import { ConfigValidationError } from "./config-validation-error.js";
import {
  DEFAULT_FUSION_WORKERS,
  FUSION_WORKERS_MAX,
  FUSION_WORKERS_MIN,
  parseLlmRunModeConfig,
  scrubRunModeProviderPins,
} from "./llm-run-mode-config.js";

const providers = [
  { id: "local-llama", kind: "llama-server" },
  { id: "openrouter", kind: "openrouter" },
  { id: "claude-cli", kind: "subscription-cli" },
];

describe("parseLlmRunModeConfig", () => {
  it("accepts an empty block", () => {
    expect(parseLlmRunModeConfig({}, providers, "llm.runMode")).toEqual({});
  });

  it.each(["local", "cloud", "fusion"] as const)("accepts mode %s", (mode) => {
    expect(parseLlmRunModeConfig({ mode }, providers, "llm.runMode")).toEqual({
      mode,
    });
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      parseLlmRunModeConfig({ mode: "hybrid" }, providers, "llm.runMode"),
    ).toThrow(ConfigValidationError);
    expect(() =>
      parseLlmRunModeConfig({ mode: "hybrid" }, providers, "llm.runMode"),
    ).toThrow(/llm\.runMode\.mode/);
  });

  it("rejects a non-object block", () => {
    expect(() =>
      parseLlmRunModeConfig("fusion", providers, "llm.runMode"),
    ).toThrow(/expected object/);
    expect(() => parseLlmRunModeConfig([], providers, "llm.runMode")).toThrow(
      /expected object/,
    );
  });

  it("round-trips a full fusion block", () => {
    const fusion = {
      orchestratorProvider: "openrouter",
      orchestratorModel: "anthropic/claude-sonnet-4.5",
      workerProvider: "local-llama",
      workerModel: "qwen-3.5-4b",
      workers: 4,
      workerMaxSteps: 25,
      workerTimeoutMs: 120_000,
    };
    expect(
      parseLlmRunModeConfig(
        { mode: "fusion", fusion },
        providers,
        "llm.runMode",
      ),
    ).toEqual({
      mode: "fusion",
      fusion,
    });
  });

  it("omits fusion keys that were not given", () => {
    const parsed = parseLlmRunModeConfig(
      { fusion: { workers: 3 } },
      providers,
      "llm.runMode",
    );
    expect(parsed).toEqual({ fusion: { workers: 3 } });
    expect("orchestratorProvider" in (parsed.fusion ?? {})).toBe(false);
  });

  it("accepts a subscription-cli provider as the orchestrator", () => {
    expect(
      parseLlmRunModeConfig(
        { fusion: { orchestratorProvider: "claude-cli" } },
        providers,
        "llm.runMode",
      ),
    ).toEqual({ fusion: { orchestratorProvider: "claude-cli" } });
  });

  it("rejects an orchestrator pin that names a llama-server provider", () => {
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { orchestratorProvider: "local-llama" } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(
      /llm\.runMode\.fusion\.orchestratorProvider.*must be a cloud provider/,
    );
  });

  it("rejects a worker pin that names a cloud provider", () => {
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { workerProvider: "openrouter" } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/llm\.runMode\.fusion\.workerProvider.*must be llama-server/);
  });

  it("rejects a pin to a provider that is not configured", () => {
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { orchestratorProvider: "nope" } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/unknown provider id "nope"/);
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { workerProvider: "" } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/expected non-empty string/);
  });

  it.each([0, 9, 2.5, "3", -1])("rejects workers = %s", (workers) => {
    expect(() =>
      parseLlmRunModeConfig({ fusion: { workers } }, providers, "llm.runMode"),
    ).toThrow(/llm\.runMode\.fusion\.workers/);
  });

  it("accepts the worker-count bounds", () => {
    for (const workers of [FUSION_WORKERS_MIN, FUSION_WORKERS_MAX]) {
      expect(
        parseLlmRunModeConfig({ fusion: { workers } }, providers, "llm.runMode")
          .fusion?.workers,
      ).toBe(workers);
    }
    expect(DEFAULT_FUSION_WORKERS).toBeGreaterThanOrEqual(FUSION_WORKERS_MIN);
    expect(DEFAULT_FUSION_WORKERS).toBeLessThanOrEqual(FUSION_WORKERS_MAX);
  });

  it("bounds the worker step and time ceilings", () => {
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { workerMaxSteps: 0 } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/workerMaxSteps/);
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { workerTimeoutMs: 10 } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/workerTimeoutMs/);
  });

  it("rejects an empty model label", () => {
    expect(() =>
      parseLlmRunModeConfig(
        { fusion: { orchestratorModel: "" } },
        providers,
        "llm.runMode",
      ),
    ).toThrow(/orchestratorModel/);
  });
});

describe("scrubRunModeProviderPins", () => {
  it("returns the block untouched when nothing points at the removed id", () => {
    const block = {
      mode: "fusion" as const,
      fusion: { orchestratorProvider: "openrouter" },
    };
    expect(scrubRunModeProviderPins(block, "groq")).toBe(block);
    expect(scrubRunModeProviderPins(undefined, "groq")).toBeUndefined();
    const noFusion = { mode: "cloud" as const };
    expect(scrubRunModeProviderPins(noFusion, "openrouter")).toBe(noFusion);
  });

  it("drops only the pin that names the removed provider", () => {
    const block = {
      mode: "fusion" as const,
      fusion: {
        orchestratorProvider: "openrouter",
        workerProvider: "local-llama",
        workers: 3,
      },
    };
    expect(scrubRunModeProviderPins(block, "openrouter")).toEqual({
      mode: "fusion",
      fusion: { workerProvider: "local-llama", workers: 3 },
    });
    expect(scrubRunModeProviderPins(block, "local-llama")).toEqual({
      mode: "fusion",
      fusion: { orchestratorProvider: "openrouter", workers: 3 },
    });
  });
});
