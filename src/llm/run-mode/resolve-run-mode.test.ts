import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { resolveRunMode } from "./resolve-run-mode.js";

function llm(
  active: string,
  runMode?: UserLlmRunModeConfig,
  providers: ResolvedLlmConfig["providers"] = [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    {
      id: "openrouter",
      kind: "openrouter",
      defaultChatModel: "anthropic/claude-sonnet-4.5",
    },
    { id: "groq", kind: "openai-compatible", defaultChatModel: "llama-3.3" },
  ],
): ResolvedLlmConfig {
  return {
    activeTextProvider: active,
    activeEmbeddingProvider: "local-llama",
    providers,
    toolTransport: "auto",
    ...(runMode ? { runMode } : {}),
  };
}

describe("resolveRunMode", () => {
  it("derives local from a llama-server active provider when the block is absent", () => {
    const rm = resolveRunMode(llm("local-llama"));
    expect(rm.stored).toBeNull();
    expect(rm.effective).toBe("local");
    expect(rm.primaryProviderId).toBe("local-llama");
    expect(rm.degraded).toBeNull();
  });

  it("derives cloud from a cloud active provider when the block is absent", () => {
    const rm = resolveRunMode(llm("groq"));
    expect(rm.effective).toBe("cloud");
    expect(rm.primaryProviderId).toBe("groq");
  });

  it("finds the legs by kind: first llama-server is the worker, active cloud is the orchestrator", () => {
    const rm = resolveRunMode(llm("groq", { mode: "fusion" }));
    expect(rm.workerProviderId).toBe("local-llama");
    expect(rm.orchestratorProviderId).toBe("groq");
    expect(rm.effective).toBe("fusion");
  });

  it("falls back to the first cloud provider when the active one is local", () => {
    const rm = resolveRunMode(llm("local-llama", { mode: "fusion" }));
    expect(rm.orchestratorProviderId).toBe("openrouter");
    // Fusion is stored but the orchestrator is not active, so it is not effective.
    expect(rm.effective).toBe("local");
    expect(rm.degraded).toBeNull();
  });

  it("honours pinned legs", () => {
    const rm = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "openrouter",
          workerProvider: "local-llama",
        },
      }),
    );
    expect(rm.effective).toBe("fusion");
    expect(rm.orchestratorProviderId).toBe("openrouter");
    expect(rm.primaryProviderId).toBe("openrouter");
  });

  it("drops to the derived mode when the operator switched provider by hand", () => {
    const rm = resolveRunMode(
      llm("groq", {
        mode: "fusion",
        fusion: { orchestratorProvider: "openrouter" },
      }),
    );
    expect(rm.stored).toBe("fusion");
    expect(rm.effective).toBe("cloud");
    expect(rm.degraded).toBeNull();
  });

  it("degrades fusion with no cloud provider to local", () => {
    const rm = resolveRunMode(
      llm("local-llama", { mode: "fusion" }, [
        {
          id: "local-llama",
          kind: "llama-server",
          url: "http://127.0.0.1:19091",
        },
      ]),
    );
    expect(rm.effective).toBe("local");
    expect(rm.degraded).toEqual({
      reason: "no-cloud-provider",
      requested: "fusion",
    });
    expect(rm.orchestratorProviderId).toBeNull();
  });

  it("degrades fusion to cloud-only when there is no second provider", () => {
    const rm = resolveRunMode(
      llm("groq", { mode: "fusion" }, [
        {
          id: "groq",
          kind: "openai-compatible",
          defaultChatModel: "llama-3.3",
        },
      ]),
    );
    expect(rm.effective).toBe("cloud");
    expect(rm.degraded).toEqual({
      reason: "no-second-provider",
      requested: "fusion",
    });
    expect(rm.workerProviderId).toBeNull();
  });

  it("degrades a stored cloud mode with no cloud provider", () => {
    const rm = resolveRunMode(
      llm("local-llama", { mode: "cloud" }, [
        {
          id: "local-llama",
          kind: "llama-server",
          url: "http://127.0.0.1:19091",
        },
      ]),
    );
    expect(rm.degraded).toEqual({
      reason: "no-cloud-provider",
      requested: "cloud",
    });
  });

  it("assumes local for an unresolvable active provider and never leaves primary empty", () => {
    const rm = resolveRunMode(llm("ghost", { mode: "fusion" }));
    expect(rm.effective).toBe("local");
    expect(rm.primaryProviderId).toBe("local-llama");
    const bare = resolveRunMode(llm("ghost", undefined, []));
    expect(bare.primaryProviderId).toBe("ghost");
  });

  it("accepts a subscription-cli provider as the orchestrator", () => {
    const rm = resolveRunMode(
      llm("claude-cli", { mode: "fusion" }, [
        {
          id: "local-llama",
          kind: "llama-server",
          url: "http://127.0.0.1:19091",
        },
        {
          id: "claude-cli",
          kind: "subscription-cli",
          defaultChatModel: "sonnet",
        },
      ]),
    );
    expect(rm.effective).toBe("fusion");
    expect(rm.orchestratorProviderId).toBe("claude-cli");
  });

  it("labels the models from the provider default and the managed daemon, unless pinned", () => {
    const rm = resolveRunMode(llm("openrouter", { mode: "fusion" }), {
      managedModelId: "qwen-3.5-4b",
    });
    expect(rm.orchestratorModel).toBe("anthropic/claude-sonnet-4.5");
    expect(rm.workerModel).toBe("qwen-3.5-4b");
    const pinned = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: { orchestratorModel: "opus", workerModel: "gemma" },
      }),
      { managedModelId: "qwen-3.5-4b" },
    );
    expect(pinned.orchestratorModel).toBe("opus");
    expect(pinned.workerModel).toBe("gemma");
    expect(
      resolveRunMode(llm("openrouter", { mode: "fusion" })).workerModel,
    ).toBeNull();
  });

  it("applies the worker defaults and honours overrides", () => {
    expect(resolveRunMode(llm("openrouter", { mode: "fusion" }))).toMatchObject(
      {
        workers: 2,
        workerMaxSteps: 40,
        workerTimeoutMs: 600_000,
      },
    );
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { workers: 5, workerMaxSteps: 10, workerTimeoutMs: 5_000 },
        }),
      ),
    ).toMatchObject({ workers: 5, workerMaxSteps: 10, workerTimeoutMs: 5_000 });
  });
});

describe("resolveRunMode with the legs swapped", () => {
  it("runs the orchestrator locally and the workers in the cloud when pinned that way", () => {
    // The pairing fusion was built for is cloud thinking + local bulk,
    // but neither leg is nailed to a kind: an operator who wants cheap
    // local planning driving capable cloud executors gets it.
    const rm = resolveRunMode(
      llm(
        "local-llama",
        {
          mode: "fusion",
          fusion: {
            orchestratorProvider: "local-llama",
            workerProvider: "openrouter",
          },
        },
        [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:8080" },
          { id: "openrouter", kind: "openai-compatible", defaultChatModel: "sonnet" },
        ],
      ),
    );
    expect(rm.effective).toBe("fusion");
    expect(rm.orchestratorProviderId).toBe("local-llama");
    expect(rm.workerProviderId).toBe("openrouter");
    expect(rm.degraded).toBeNull();
  });

  it("never puts the same provider on both legs by default", () => {
    // One provider doing both halves is not a fan-out; it is the same
    // model billed twice.
    const rm = resolveRunMode(
      llm("openrouter", { mode: "fusion" }, [
        { id: "openrouter", kind: "openai-compatible", defaultChatModel: "sonnet" },
        { id: "groq", kind: "openai-compatible", defaultChatModel: "llama-3.3" },
      ]),
    );
    expect(rm.orchestratorProviderId).toBe("openrouter");
    expect(rm.workerProviderId).toBe("groq");
    expect(rm.effective).toBe("fusion");
  });
});
