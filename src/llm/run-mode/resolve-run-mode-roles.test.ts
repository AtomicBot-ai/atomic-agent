import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { resolveRunMode } from "./resolve-run-mode.js";

function llm(runMode: UserLlmRunModeConfig): ResolvedLlmConfig {
  return {
    activeTextProvider: "openrouter",
    activeEmbeddingProvider: "local-llama",
    providers: [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      { id: "small-llama", kind: "llama-server", url: "http://127.0.0.1:19092", model: "qwen3-8b" },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "anthropic/claude-sonnet-4.5" },
      { id: "or-coder", kind: "openrouter", defaultChatModel: "qwen/qwen3-coder" },
    ],
    toolTransport: "auto",
    runMode,
  };
}

describe("resolveRunMode roles (ATO-943)", () => {
  it("leaves roles out when none are configured", () => {
    const rm = resolveRunMode(llm({ mode: "fusion" }), { managedModelId: "qwen-14b" });
    expect(rm).not.toHaveProperty("roles");
  });

  it("resolves each role to its provider, label and kind", () => {
    const rm = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: {
          roles: {
            build: "or-coder",
            utility: "small-llama",
            explore: "local-llama",
            plan: "openrouter",
          },
        },
      }),
      { managedModelId: "qwen-14b" },
    );
    expect(rm.roles).toEqual({
      byRole: {
        plan: { providerId: "openrouter", model: "anthropic/claude-sonnet-4.5", local: false },
        build: { providerId: "or-coder", model: "qwen/qwen3-coder", local: false },
        // The worker leg's own label, the managed model.
        explore: { providerId: "local-llama", model: "qwen-14b", local: true },
        utility: { providerId: "small-llama", model: "qwen3-8b", local: true },
      },
      mixLocalModels: false,
      localLegProviderIds: ["local-llama"],
    });
    // The orchestrator is not switched by the plan role.
    expect(rm.orchestratorProviderId).toBe("openrouter");
  });

  it("carries mixLocalModels", () => {
    const rm = resolveRunMode(
      llm({ mode: "fusion", fusion: { roles: { utility: "small-llama" }, mixLocalModels: true } }),
    );
    expect(rm.roles?.mixLocalModels).toBe(true);
  });

  it("feeds the review role to the judge when no judge provider is pinned", () => {
    const review = resolveRunMode(
      llm({ mode: "fusion", fusion: { judge: "on", roles: { review: "or-coder" } } }),
    );
    expect(review.judge).toEqual({ providerId: "or-coder", model: "qwen/qwen3-coder" });
    const pinned = resolveRunMode(
      llm({
        mode: "fusion",
        fusion: { judge: "on", judgeProvider: "openrouter", roles: { review: "or-coder" } },
      }),
    );
    expect(pinned.judge?.providerId).toBe("openrouter");
    const off = resolveRunMode(
      llm({ mode: "fusion", fusion: { roles: { review: "or-coder" } } }),
    );
    expect(off.judge).toBeNull();
  });
});
