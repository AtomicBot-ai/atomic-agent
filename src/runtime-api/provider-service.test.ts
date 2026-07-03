import { describe, expect, it, vi } from "vitest";

import type { ProviderCapabilities } from "../llm/provider/llm-provider.js";
import { RuntimeApiError } from "./runtime-api-error.js";
import {
  listProviders,
  reloadProvider,
  removeProvider,
  setActiveProvider,
  type ProviderServiceDeps,
} from "./provider-service.js";

const CAPS: ProviderCapabilities = {
  vision: false,
  visionSource: "absent",
  toolTransport: "grammar",
  contextWindow: 8192,
  supportsParallelTools: true,
  supportsSlotAffinity: true,
  supportsPromptCache: true,
  reasoningFormat: "none",
};

function makeDeps(
  overrides: Partial<ProviderServiceDeps> = {},
): ProviderServiceDeps {
  return {
    listIds: vi.fn(() => ["local-llama", "openrouter"]),
    getCapabilities: vi.fn(() => CAPS),
    getActiveTextId: vi.fn(() => "local-llama"),
    listConfigEntries: vi.fn(() => [
      { id: "local-llama", kind: "llama-server", chatModel: null, hasApiKey: false },
      {
        id: "openrouter",
        kind: "openrouter",
        chatModel: "anthropic/claude",
        hasApiKey: true,
      },
    ]),
    setActive: vi.fn(async () => undefined),
    removeProvider: vi.fn(async () => undefined),
    reloadProvider: vi.fn(async () => undefined),
    reloadProviders: vi.fn(async () => undefined),
    setActiveInConfig: vi.fn(),
    removeFromConfig: vi.fn(),
    ...overrides,
  };
}

describe("provider-service facade", () => {
  it("lists providers with active flag + live capabilities", () => {
    const deps = makeDeps();
    const result = listProviders(deps);
    expect(result.activeTextId).toBe("local-llama");
    expect(result.providers).toHaveLength(2);
    const local = result.providers.find((p) => p.id === "local-llama");
    expect(local?.isActiveText).toBe(true);
    expect(local?.capabilities).toEqual(CAPS);
    const remote = result.providers.find((p) => p.id === "openrouter");
    expect(remote?.hasApiKey).toBe(true);
    expect(remote?.chatModel).toBe("anthropic/claude");
  });

  it("appends registry-only ids not present in config", () => {
    const deps = makeDeps({
      listIds: vi.fn(() => ["local-llama", "openrouter", "ghost"]),
      listConfigEntries: vi.fn(() => [
        { id: "openrouter", kind: "openrouter", chatModel: null, hasApiKey: true },
      ]),
      getActiveTextId: vi.fn(() => "ghost"),
    });
    const result = listProviders(deps);
    const ghost = result.providers.find((p) => p.id === "ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.isActiveText).toBe(true);
  });

  it("sets active, persists, and returns the new active id", async () => {
    const deps = makeDeps({ getActiveTextId: vi.fn(() => "openrouter") });
    const result = await setActiveProvider(deps, "openrouter");
    expect(deps.setActive).toHaveBeenCalledWith("openrouter");
    expect(deps.setActiveInConfig).toHaveBeenCalledWith("openrouter");
    expect(result.activeTextId).toBe("openrouter");
  });

  it("rejects setActive for an unregistered id", async () => {
    const deps = makeDeps();
    await expect(setActiveProvider(deps, "nope")).rejects.toBeInstanceOf(
      RuntimeApiError,
    );
    expect(deps.setActive).not.toHaveBeenCalled();
  });

  it("reloads one provider by id", async () => {
    const deps = makeDeps();
    await reloadProvider(deps, "openrouter");
    expect(deps.reloadProvider).toHaveBeenCalledWith("openrouter");
    expect(deps.reloadProviders).not.toHaveBeenCalled();
  });

  it("reloads all providers when no id is given", async () => {
    const deps = makeDeps();
    await reloadProvider(deps);
    expect(deps.reloadProviders).toHaveBeenCalledOnce();
    expect(deps.reloadProvider).not.toHaveBeenCalled();
  });

  it("refuses to remove the active provider (conflict)", async () => {
    const deps = makeDeps();
    await expect(removeProvider(deps, "local-llama")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(deps.removeFromConfig).not.toHaveBeenCalled();
  });

  it("removes a non-active provider from config then registry", async () => {
    const deps = makeDeps();
    await removeProvider(deps, "openrouter");
    expect(deps.removeFromConfig).toHaveBeenCalledWith("openrouter");
    expect(deps.removeProvider).toHaveBeenCalledWith("openrouter");
    expect(deps.reloadProviders).toHaveBeenCalledOnce();
  });
});
