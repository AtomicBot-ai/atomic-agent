import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetConfigCache } from "../../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../../config/config-schema.js";
import type { AgentRuntime } from "../../runtime/bootstrap.js";
import { ProvidersOrchestrator } from "./providers-orchestrator.js";

/**
 * `removeProviderById` against a real config file. The panel's
 * `isActiveText` is a snapshot from the last refresh, so the
 * orchestrator must re-check the live active provider itself and write
 * NOTHING when it refuses — the registry's own guard only runs after
 * `removeLlmProvider` has already rewritten the file.
 */
describe("ProvidersOrchestrator.removeProviderById", () => {
  let stateDir: string;

  function write(activeTextProvider: string): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider,
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server" },
          {
            id: "openrouter",
            kind: "openrouter",
            defaultChatModel: "openai/gpt-4o-mini",
          },
          {
            id: "groq",
            kind: "openai-compatible",
            baseUrl: "https://api.groq.com/openai/v1",
          },
        ],
        fallback: { chain: ["openrouter", "groq"] },
      },
    } as never);
    resetConfigCache();
  }

  function rawFile(): string {
    return readFileSync(getUserConfigPath(stateDir), "utf8");
  }

  function setup(registryActiveId: string) {
    const removeProvider = vi.fn(async () => {});
    const runtime = {
      providerRegistry: {
        activeTextProviderId: registryActiveId,
        removeProvider,
        listIds: () => [] as string[],
      },
      reloadLlmProviders: vi.fn(async () => {}),
    } as unknown as AgentRuntime;
    const bus = { subscribe: vi.fn(() => () => {}), emit: vi.fn() };
    const orchestrator = new ProvidersOrchestrator(runtime, bus as never);
    const emitted = () =>
      bus.emit.mock.calls.map((call) => call[0] as Record<string, unknown>);
    return { orchestrator, runtime, removeProvider, emitted };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-remove-orch-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("refuses the provider the runtime is serving chat from, file untouched", async () => {
    // Stale panel: config on disk still says local-llama, but the
    // runtime already switched to openrouter (Telegram /model, a run-mode
    // change outside the TUI). The row looked removable.
    write("local-llama");
    const before = rawFile();
    const { orchestrator, removeProvider, runtime, emitted } =
      setup("openrouter");

    await orchestrator.removeProviderById("openrouter");

    expect(rawFile()).toBe(before);
    expect(removeProvider).not.toHaveBeenCalled();
    expect(runtime.reloadLlmProviders).not.toHaveBeenCalled();
    const failed = emitted().find((a) => a.type === "providers_remove_failed");
    expect(failed?.error).toMatch(/openrouter is the active provider; switch/);
    expect(emitted().some((a) => a.type === "providers_remove_succeeded")).toBe(
      false,
    );
  });

  it("refuses the provider the config file marks active, file untouched", async () => {
    write("openrouter");
    const before = rawFile();
    const { orchestrator, removeProvider } = setup("local-llama");

    await orchestrator.removeProviderById("openrouter");

    expect(rawFile()).toBe(before);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  it("removes an inactive provider from the file and the registry", async () => {
    write("openrouter");
    const { orchestrator, removeProvider, emitted } = setup("openrouter");

    await orchestrator.removeProviderById("groq");

    const llm = (
      JSON.parse(rawFile()) as {
        llm: {
          activeTextProvider: string;
          providers: Array<{ id: string }>;
          fallback?: { chain?: string[] };
        };
      }
    ).llm;
    expect(llm.providers.map((p) => p.id)).toEqual([
      "local-llama",
      "openrouter",
    ]);
    expect(llm.activeTextProvider).toBe("openrouter");
    expect(llm.fallback?.chain).toEqual(["openrouter"]);
    expect(removeProvider).toHaveBeenCalledWith("groq");
    expect(emitted().some((a) => a.type === "providers_remove_succeeded")).toBe(
      true,
    );
  });
});
