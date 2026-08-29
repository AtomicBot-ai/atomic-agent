import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRuntime } from "../../runtime/bootstrap.js";
import type { AtomicAgentConfig } from "../../config/index.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

vi.mock("../../config/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../config/index.js")>();
  return {
    ...original,
    getConfig: () => currentConfig,
  };
});

let currentConfig: AtomicAgentConfig;

function configWithGemini(): AtomicAgentConfig {
  return {
    llm: {
      activeTextProvider: "gemini",
      activeEmbeddingProvider: "local-llama-embed",
      toolTransport: "auto",
      providers: [
        {
          id: "gemini",
          kind: "gemini",
          defaultChatModel: "gemini-2.5-flash",
        },
      ],
    },
  } as AtomicAgentConfig;
}

/**
 * The catalog caches live at module scope inside the fetch modules, so
 * every test builds the orchestrator from a fresh module registry: a
 * warm cache inherited from a previous test would silently skip the
 * network path under test.
 */
async function importFreshOrchestrator() {
  vi.resetModules();
  return import("./providers-orchestrator.js");
}

function fakeBus() {
  return {
    subscribe: vi.fn(() => () => {}),
    emit: vi.fn(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function stubCatalogFetch() {
  const fetchMock = vi.fn(async (url: unknown) => {
    if (String(url).includes("openrouter")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            {
              id: "vendor/live-or",
              context_length: 128_000,
              supported_parameters: ["tools"],
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: [{ id: "vendor/live-aiml", type: "chat-completion" }],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ProvidersOrchestrator.prefetchCloudCatalogs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches both catalogs when cold and reports via providers_status", async () => {
    const fetchMock = stubCatalogFetch();
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();

    const urls = fetchMock.mock.calls.map((call) => String(call[0])).sort();
    expect(urls).toEqual([
      "https://api.aimlapi.com/v1/models",
      "https://openrouter.ai/api/v1/models",
    ]);
    // The status emits are what re-render already-mounted panels so
    // they re-read the now-live module cache.
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_status",
      line: "OpenRouter model list updated from API",
    });
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_status",
      line: "AI/ML API model list updated from API",
    });
  });

  it("skips the network entirely while the caches are warm", async () => {
    const fetchMock = stubCatalogFetch();
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Wired to tab activation, this runs on every providers/LLM tab
    // visit; within the cache TTL it must stay free.
    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the static fallback intact when both fetches fail", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    orchestrator.prefetchCloudCatalogs();
    await flush();

    // No success status lines and no crash; the pickers keep serving
    // the static catalog.
    expect(bus.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "providers_status" }),
    );

    // A cold cache means the next visit retries instead of latching
    // onto the failure.
    orchestrator.prefetchCloudCatalogs();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("isCloudProviderKind", () => {
  it("allows an existing Gemini provider to enter configure and key-repair flows", async () => {
    const { isCloudProviderKind } = await importFreshOrchestrator();

    expect(isCloudProviderKind("gemini")).toBe(true);
  });

  it("stays false for subscription-cli, which is not a key-based cloud kind", async () => {
    const { isCloudProviderKind } = await importFreshOrchestrator();

    expect(isCloudProviderKind("subscription-cli")).toBe(false);
  });
});

describe("configureWizardKindForRow", () => {
  it("recovers the wizard row behind a stored subscription-cli entry", async () => {
    const { configureWizardKindForRow } = await importFreshOrchestrator();

    // Two wizard rows collapse onto one config kind, so the CLI name on
    // the entry is the only thing that can tell them apart.
    expect(
      configureWizardKindForRow({
        kind: "subscription-cli",
        subscriptionCli: { cli: "claude" },
      }),
    ).toBe("claude-cli");
    expect(
      configureWizardKindForRow({
        kind: "subscription-cli",
        subscriptionCli: { cli: "codex" },
      }),
    ).toBe("codex-cli");
  });

  it("passes key-based cloud kinds through unchanged", async () => {
    const { configureWizardKindForRow } = await importFreshOrchestrator();

    expect(configureWizardKindForRow({ kind: "gemini" })).toBe("gemini");
    expect(configureWizardKindForRow({ kind: "openai-compatible" })).toBe(
      "openai-compatible",
    );
  });

  it("has no wizard for the local daemon or an unknown CLI", async () => {
    const { configureWizardKindForRow } = await importFreshOrchestrator();

    expect(configureWizardKindForRow({ kind: "llama-server" })).toBeNull();
    expect(
      configureWizardKindForRow({ kind: "subscription-cli", subscriptionCli: null }),
    ).toBeNull();
    expect(
      configureWizardKindForRow({
        kind: "subscription-cli",
        subscriptionCli: { cli: "not-a-cli" },
      }),
    ).toBeNull();
  });
});

describe("ProvidersOrchestrator.ensureInlineModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("warms the Gemini model catalog through the Cloud pane path", async () => {
    currentConfig = configWithGemini();
    const fetchMock = vi.fn(async (url: unknown) => ({
      ok: true,
      json: async () => ({
        data: [{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    await orchestrator.ensureInlineModels("gemini");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    );
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_inline_models_loading",
      providerId: "gemini",
      generation: 1,
    });
    expect(bus.emit).toHaveBeenCalledWith({
      type: "providers_inline_models_loaded",
      providerId: "gemini",
      generation: 1,
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
  });

  it("reports failure without latching when the Gemini catalog fetch fails", async () => {
    currentConfig = configWithGemini();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(
      {} as AgentRuntime,
      bus as never,
    );

    await orchestrator.ensureInlineModels("gemini");

    expect(bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "providers_inline_models_failed",
        providerId: "gemini",
      }),
    );
  });
});

describe("ProvidersOrchestrator.completeWizard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function wizardFor(kind: "openrouter" | "aimlapi"): ProvidersWizardState {
    return {
      ...createProvidersWizardState("add", { kind }),
      phase: "api_key",
      apiKeyBuffer: "sk-wizard-key",
    };
  }

  function fakeRuntime() {
    return {
      providerRegistry: {
        setActive: vi.fn(async () => {}),
        listIds: () => [] as string[],
      },
      reloadLlmProvider: vi.fn(async () => {}),
      reloadLlmProviders: vi.fn(async () => {}),
      reportModelConfigured: vi.fn(),
    } as unknown as AgentRuntime;
  }

  it("refuses to save a key the provider will not honour", async () => {
    currentConfig = configWithGemini();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "Insufficient credits" }), {
          status: 402,
        }),
      ),
    );
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const runtime = fakeRuntime();
    const orchestrator = new ProvidersOrchestrator(runtime, bus as never);

    await orchestrator.completeWizard(wizardFor("openrouter"));

    const types = bus.emit.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toContain("providers_wizard_failed");
    expect(types).not.toContain("providers_wizard_succeeded");
    // Nothing reloaded means nothing was written: the save never ran.
    expect(runtime.reloadLlmProviders).not.toHaveBeenCalled();
    expect(runtime.reloadLlmProvider).not.toHaveBeenCalled();
  });

  it("reports the failure in words the operator can act on", async () => {
    currentConfig = configWithGemini();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "No auth credentials found" }), {
          status: 401,
        }),
      ),
    );
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const orchestrator = new ProvidersOrchestrator(fakeRuntime(), bus as never);

    await orchestrator.completeWizard(wizardFor("aimlapi"));

    const failure = bus.emit.mock.calls
      .map((call) => call[0] as { type: string; error?: string })
      .find((action) => action.type === "providers_wizard_failed");
    expect(failure?.error).toContain("rejected this key");
  });

  it("hands the cancel back to the wizard while a check is in flight", async () => {
    currentConfig = configWithGemini();
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response("{}", { status: 401 });
      }),
    );
    const { ProvidersOrchestrator } = await importFreshOrchestrator();
    const bus = fakeBus();
    const runtime = fakeRuntime();
    const orchestrator = new ProvidersOrchestrator(runtime, bus as never);

    const running = orchestrator.completeWizard(wizardFor("openrouter"));
    await flush();
    // Still waiting on the provider: submitting is on, nothing saved.
    const midTypes = bus.emit.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(midTypes).toContain("providers_wizard_submit_started");
    expect(midTypes).not.toContain("providers_wizard_succeeded");

    orchestrator.cancelWizardVerification();
    const cancelTypes = bus.emit.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(cancelTypes).toContain("providers_wizard_verify_cancelled");

    releaseFetch();
    await running;
    expect(runtime.reloadLlmProviders).not.toHaveBeenCalled();
    // The late answer from the abandoned check stays quiet: the wizard is
    // already back under the operator's hands.
    const finalTypes = bus.emit.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(finalTypes).not.toContain("providers_wizard_failed");
  });

});
