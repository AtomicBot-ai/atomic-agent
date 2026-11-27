import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { resolveRunMode } from "./resolve-run-mode.js";

// The setup from the Discord report: one OpenRouter entry for the cloud
// roles, a local server for the workers.
function llm(runMode: UserLlmRunModeConfig): ResolvedLlmConfig {
  return {
    activeTextProvider: "openrouter",
    activeEmbeddingProvider: "local-llama",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "anthropic/claude-opus-5.5" },
    ],
    toolTransport: "auto",
    runMode,
  };
}

describe("resolveRunMode: roles sharing one provider entry (roleModels)", () => {
  it("gives each role on the shared entry its own model on the wire", () => {
    const rm = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: {
          roles: { review: "openrouter", build: "openrouter", plan: "openrouter" },
          roleModels: { review: "deepseek/deepseek-v4.1", build: "qwen/qwen3.8-27b" },
        },
      }),
      { managedModelId: "qwen-14b" },
    );
    expect(rm.roles?.byRole.review).toEqual({
      providerId: "openrouter",
      model: "deepseek/deepseek-v4.1",
      turnModel: "deepseek/deepseek-v4.1",
      local: false,
    });
    expect(rm.roles?.byRole.build?.turnModel).toBe("qwen/qwen3.8-27b");
    // A role with no model of its own reads the entry as before.
    expect(rm.roles?.byRole.plan).toEqual({
      providerId: "openrouter",
      model: "anthropic/claude-opus-5.5",
      local: false,
    });
  });

  it("names the entry's own model when the orchestrator asks the same entry for another", () => {
    const rm = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: {
          orchestratorModel: "openai/gpt-6",
          roles: { review: "openrouter" },
          roleModels: { review: "anthropic/claude-opus-5.5" },
        },
      }),
    );
    // Unnamed, the request would take the orchestrator's model.
    expect(rm.roles?.byRole.review?.turnModel).toBe("anthropic/claude-opus-5.5");
  });

  it("ignores a role model on a llama-server entry, which serves what it loaded", () => {
    const rm = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: { roles: { utility: "local-llama" }, roleModels: { utility: "other-model" } },
      }),
      { managedModelId: "qwen-14b" },
    );
    expect(rm.roles?.byRole.utility).toEqual({
      providerId: "local-llama",
      model: "qwen-14b",
      local: true,
    });
  });

  it("feeds the review role's own model to the judge", () => {
    const rm = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: {
          judge: "on",
          roles: { review: "openrouter" },
          roleModels: { review: "deepseek/deepseek-v4.1" },
        },
      }),
    );
    expect(rm.judge).toEqual({
      providerId: "openrouter",
      model: "deepseek/deepseek-v4.1",
      turnModel: "deepseek/deepseek-v4.1",
    });
  });
});
