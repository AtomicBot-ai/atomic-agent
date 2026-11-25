import { describe, expect, it } from "vitest";

import {
  DEFAULT_FUSION_WORKER_TIMEOUT_MS,
  type UserLlmRunModeConfig,
} from "../../config/llm-run-mode-config.js";
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

  it("never labels a foreign llama.cpp worker with the managed model (ATO-1562)", () => {
    const providers: ResolvedLlmConfig["providers"] = [
      { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
      { id: "my-llama", kind: "llama-server", url: "http://127.0.0.1:8080", model: "huihui-qwen3.8-27b" },
      { id: "openrouter", kind: "openrouter", defaultChatModel: "anthropic/claude-sonnet-4.5" },
    ];
    const foreign = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "my-llama" } }, providers),
      { managedModelId: "qwen-3.5-4b", localServerUrl: "http://127.0.0.1:19091/" },
    );
    expect(foreign.workerModel).toBe("huihui-qwen3.8-27b");

    // The main local server is still described by the managed model.
    const ours = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "local-llama" } }, providers),
      { managedModelId: "qwen-3.5-4b", localServerUrl: "http://127.0.0.1:19091" },
    );
    expect(ours.workerModel).toBe("qwen-3.5-4b");

    // In managed mode `local-llama` is built from the daemon's port, so
    // its URL need not match `localModels.url`; it is still ours.
    const managedPort = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "local-llama" } }, providers),
      { managedModelId: "qwen-3.5-4b", localServerUrl: "http://127.0.0.1:8080" },
    );
    expect(managedPort.workerModel).toBe("qwen-3.5-4b");

    // A foreign entry that names no model has no label to guess.
    const unnamed = resolveRunMode(
      llm(
        "openrouter",
        { mode: "fusion", fusion: { workerProvider: "my-llama" } },
        providers.map((p) => (p.id === "my-llama" ? { id: p.id, kind: p.kind, url: p.url } : p)),
      ),
      { managedModelId: "qwen-3.5-4b", localServerUrl: "http://127.0.0.1:19091" },
    );
    expect(unnamed.workerModel).toBeNull();
  });

  it("applies the worker defaults and honours overrides", () => {
    expect(resolveRunMode(llm("openrouter", { mode: "fusion" }))).toMatchObject(
      {
        workers: 2,
        cloudWorkers: 4,
        workersPinned: false,
        workerMaxSteps: 60,
        workerTimeoutMs: DEFAULT_FUSION_WORKER_TIMEOUT_MS,
      },
    );
    expect(
      resolveRunMode(
        llm("openrouter", { mode: "fusion", fusion: { cloudWorkers: 9 } }),
      ).cloudWorkers,
    ).toBe(9);
    // F20: the worker settings are present only when configured — an
    // absent one must reach the provider as "its default", not as a value.
    const plain = resolveRunMode(llm("openrouter", { mode: "fusion" }));
    expect(plain).not.toHaveProperty("workerReasoning");
    expect(plain).not.toHaveProperty("workerMaxOutputTokens");
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { workerReasoning: "high", workerMaxOutputTokens: 20_000 },
        }),
      ),
    ).toMatchObject({ workerReasoning: "high", workerMaxOutputTokens: 20_000 });
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { workers: 5, workerMaxSteps: 10, workerTimeoutMs: 5_000 },
        }),
      ),
    ).toMatchObject({
      workers: 5,
      workersPinned: true,
      workerMaxSteps: 10,
      workerTimeoutMs: 5_000,
    });
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

describe("fusion escalation target (ATO-942)", () => {
  it("defaults to the orchestrator leg, off for automatic use", () => {
    const rm = resolveRunMode(llm("openrouter", { mode: "fusion" }));
    expect(rm.escalation).toEqual({
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      auto: false,
      replace: false,
      maxUsd: 0.25,
    });
  });

  it("is null when the only candidate is the worker leg itself", () => {
    const rm = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: { escalationProvider: "local-llama", escalation: "advisor" },
      }),
    );
    expect(rm.escalation).toBeNull();
  });

  it("escalates to the orchestrator's model when both legs share one provider with two models (ATO-1561)", () => {
    const rm = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: {
          workerProvider: "openrouter",
          orchestratorModel: "model-a",
          workerModel: "model-b",
          escalation: "advisor",
        },
      }),
    );
    expect(rm.escalation).toMatchObject({
      providerId: "openrouter",
      model: "model-a",
      turnModel: "model-a",
      auto: true,
    });
    expect(rm.workerTurnModel).toBe("model-b");
  });

  it("is still null when the shared provider runs the same model on both legs (ATO-1561)", () => {
    const rm = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: { workerProvider: "openrouter", escalation: "advisor" },
      }),
    );
    expect(rm.escalation).toBeNull();
    const pinnedSame = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: { workerProvider: "openrouter", orchestratorModel: "model-a", workerModel: "model-a" },
      }),
    );
    expect(pinnedSame.escalation).toBeNull();
  });

  it("honours a pinned provider, the advisor switch, the replace flag and the cap", () => {
    const rm = resolveRunMode(
      llm("openrouter", {
        mode: "fusion",
        fusion: {
          escalation: "advisor",
          escalationProvider: "groq",
          escalationReplace: true,
          escalationMaxUsd: 1,
        },
      }),
    );
    expect(rm.escalation).toEqual({
      providerId: "groq",
      model: "llama-3.3",
      auto: true,
      replace: true,
      maxUsd: 1,
    });
  });
});

describe("resolveRunMode — task tree (ATO-940)", () => {
  it("is absent unless enabled", () => {
    expect(resolveRunMode(llm("openrouter", { mode: "fusion" })).taskTree).toBeUndefined();
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { taskTree: { enabled: false, maxDepth: 3 } },
        }),
      ).taskTree,
    ).toBeUndefined();
  });

  it("defaults to depth 2 and 24 nodes when enabled", () => {
    expect(
      resolveRunMode(
        llm("openrouter", { mode: "fusion", fusion: { taskTree: { enabled: true } } }),
      ).taskTree,
    ).toEqual({ maxDepth: 2, maxNodes: 24 });
  });

  it("treats depth 1 as the flat fan-out and honours the configured limits", () => {
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { taskTree: { enabled: true, maxDepth: 1 } },
        }),
      ).taskTree,
    ).toBeUndefined();
    expect(
      resolveRunMode(
        llm("openrouter", {
          mode: "fusion",
          fusion: { taskTree: { enabled: true, maxDepth: 3, maxNodes: 10 } },
        }),
      ).taskTree,
    ).toEqual({ maxDepth: 3, maxNodes: 10 });
  });
});

describe("resolveRunMode — the model each leg asks for (ATO-1560)", () => {
  const legs: ResolvedLlmConfig["providers"] = [
    { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
    { id: "openrouter", kind: "openrouter", defaultChatModel: "model-a" },
    { id: "lmstudio", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", defaultChatModel: "qwen-default" },
  ];

  it("asks a cloud or LM Studio worker leg for the picked worker model", () => {
    const rm = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "lmstudio", workerModel: "qwen3.8-27b" } }, legs),
    );
    expect(rm.workerModel).toBe("qwen3.8-27b");
    expect(rm.workerTurnModel).toBe("qwen3.8-27b");
  });

  it("asks nothing when the picked model is the entry's own, or the leg is llama-server", () => {
    const own = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "lmstudio", workerModel: "qwen-default" } }, legs),
    );
    expect(own).not.toHaveProperty("workerTurnModel");
    const local = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "local-llama", workerModel: "some-gguf" } }, legs),
    );
    expect(local.workerModel).toBe("some-gguf");
    expect(local).not.toHaveProperty("workerTurnModel");
    expect(resolveRunMode(llm("openrouter", { mode: "fusion" }, legs))).not.toHaveProperty("orchestratorTurnModel");
  });

  it("asks the orchestrator leg for the orchestrator model, and the judge and escalation on it too", () => {
    const rm = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { orchestratorModel: "model-big", judge: "on" } }, legs),
    );
    expect(rm.orchestratorTurnModel).toBe("model-big");
    expect(rm.escalation).toMatchObject({ providerId: "openrouter", model: "model-big", turnModel: "model-big" });
    expect(rm.judge).toEqual({ providerId: "openrouter", model: "model-big", turnModel: "model-big" });
    // The workers are on llama-server: nothing to ask for there.
    expect(rm).not.toHaveProperty("workerTurnModel");
  });

  it("gives workers on the orchestrator's provider their own model, so they do not inherit the orchestrator's", () => {
    const rm = resolveRunMode(
      llm("openrouter", { mode: "fusion", fusion: { workerProvider: "openrouter", orchestratorModel: "model-big" } }, legs),
    );
    expect(rm.orchestratorTurnModel).toBe("model-big");
    expect(rm.workerModel).toBe("model-a");
    expect(rm.workerTurnModel).toBe("model-a");
  });

  it("carries a role's model on a provider that serves several", () => {
    const rm = resolveRunMode(
      llm(
        "openrouter",
        { mode: "fusion", fusion: { orchestratorModel: "model-big", roles: { review: "openrouter", build: "lmstudio" } } },
        legs,
      ),
    );
    expect(rm.roles?.byRole.review).toEqual({ providerId: "openrouter", model: "model-big", turnModel: "model-big", local: false });
    // LM Studio's own model is what it is asked for: no per-turn model.
    expect(rm.roles?.byRole.build).toEqual({ providerId: "lmstudio", model: "qwen-default", local: false });
  });
});
