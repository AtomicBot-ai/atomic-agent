import { describe, expect, it, vi } from "vitest";

import type { ProviderCapabilities } from "../llm/provider/llm-provider.js";
import { getModelsStatus, type ModelsServiceDeps } from "./models-service.js";

const CAPS: ProviderCapabilities = {
  vision: false,
  visionSource: "absent",
  toolTransport: "grammar",
  contextWindow: 4096,
  supportsParallelTools: true,
  supportsSlotAffinity: true,
  supportsPromptCache: true,
  reasoningFormat: "none",
};

function makeDeps(
  overrides: Partial<ModelsServiceDeps> = {},
): ModelsServiceDeps {
  return {
    health: vi.fn(async () => ({
      reachable: true,
      status: 200,
      error: null,
      latencyMs: 12,
    })),
    url: "http://127.0.0.1:8080",
    mode: "external",
    activeModelId: "qwen3",
    contextWindow: 4096,
    capabilities: CAPS,
    ...overrides,
  };
}

describe("models-service facade", () => {
  it("assembles a reachable status from the active provider health", async () => {
    const deps = makeDeps();
    const status = await getModelsStatus(deps);
    expect(status).toEqual({
      reachable: true,
      url: "http://127.0.0.1:8080",
      mode: "external",
      latencyMs: 12,
      error: null,
      activeModelId: "qwen3",
      contextWindow: 4096,
      capabilities: CAPS,
    });
  });

  it("propagates an unreachable probe with its error", async () => {
    const deps = makeDeps({
      health: vi.fn(async () => ({
        reachable: false,
        status: null,
        error: "ECONNREFUSED",
        latencyMs: 3,
      })),
      activeModelId: null,
      contextWindow: null,
    });
    const status = await getModelsStatus(deps);
    expect(status.reachable).toBe(false);
    expect(status.error).toBe("ECONNREFUSED");
    expect(status.activeModelId).toBeNull();
    expect(status.contextWindow).toBeNull();
  });
});
