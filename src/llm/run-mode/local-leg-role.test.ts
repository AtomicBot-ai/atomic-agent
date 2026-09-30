import { describe, expect, it } from "vitest";

import type { UserLlmRunModeConfig } from "../../config/llm-run-mode-config.js";
import type { ResolvedLlmConfig } from "../provider/registry/provider-types.js";
import { resolveLocalLegRole } from "./local-leg-role.js";
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

function roleOf(resolved: ResolvedLlmConfig): "workers" | "orchestrator" {
  return resolveLocalLegRole(resolved, resolveRunMode(resolved));
}

describe("resolveLocalLegRole", () => {
  it("calls the local leg the orchestrator when it is pinned as one and the workers are cloud", () => {
    const resolved = llm("local-llama", {
      mode: "fusion",
      fusion: {
        orchestratorProvider: "local-llama",
        workerProvider: "groq",
      },
    });
    expect(resolveRunMode(resolved).effective).toBe("fusion");
    expect(roleOf(resolved)).toBe("orchestrator");
  });

  it("follows the resolver's default worker leg when only the orchestrator is pinned", () => {
    // With the one llama-server taken by the orchestrator, `resolveRunMode`
    // fills the worker leg from the remaining providers — a cloud one.
    const resolved = llm("local-llama", {
      mode: "fusion",
      fusion: { orchestratorProvider: "local-llama" },
    });
    const rm = resolveRunMode(resolved);
    expect(rm.effective).toBe("fusion");
    expect(rm.workerProviderId).toBe("openrouter");
    expect(roleOf(resolved)).toBe("orchestrator");
  });

  it("calls the local leg the workers in the usual cloud-orchestrated direction", () => {
    const resolved = llm("groq", { mode: "fusion" });
    const rm = resolveRunMode(resolved);
    expect(rm.effective).toBe("fusion");
    expect(rm.workerProviderId).toBe("local-llama");
    expect(roleOf(resolved)).toBe("workers");
  });

  it("stays on workers for local and cloud modes, where there is no direction to choose", () => {
    expect(roleOf(llm("local-llama"))).toBe("workers");
    expect(roleOf(llm("groq"))).toBe("workers");
    expect(roleOf(llm("local-llama", { mode: "local" }))).toBe("workers");
    expect(roleOf(llm("groq", { mode: "cloud" }))).toBe("workers");
  });

  it("stays on workers when fusion is stored but not effective", () => {
    // The operator pinned a cloud orchestrator and then switched the
    // active provider by hand: `activeTextProvider` is authoritative, so
    // this is plain local mode and the launch must not change.
    const resolved = llm("local-llama", {
      mode: "fusion",
      fusion: { orchestratorProvider: "groq", workerProvider: "local-llama" },
    });
    expect(resolveRunMode(resolved).effective).toBe("local");
    expect(roleOf(resolved)).toBe("workers");
  });

  it("stays on workers when both legs are llama-servers", () => {
    // Two local entries is not the swapped direction — whichever one the
    // managed daemon is, something is fanning out on this machine.
    const resolved = llm(
      "local-a",
      {
        mode: "fusion",
        fusion: {
          orchestratorProvider: "local-a",
          workerProvider: "local-b",
        },
      },
      [
        { id: "local-a", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "local-b", kind: "llama-server", url: "http://127.0.0.1:19092" },
      ],
    );
    expect(resolveRunMode(resolved).effective).toBe("fusion");
    expect(roleOf(resolved)).toBe("workers");
  });
});
