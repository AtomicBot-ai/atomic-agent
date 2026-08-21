import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderRow } from "./providers/providers-panel-state.js";
import { selectContextUsage } from "./select-context-usage.js";
import { fakeSession } from "./test-fixtures.js";
import {
  createInitialTuiState,
  type ContextUsageState,
  type TuiState,
} from "./tui-state.js";

function usage(overrides: Partial<ContextUsageState> = {}): ContextUsageState {
  return {
    tokens: 14_100,
    contextWindow: null,
    droppedTurns: 0,
    conversationTokens: 6400,
    conversationCap: 32_000,
    conversationCapConfigured: 32_000,
    sections: [],
    ...overrides,
  };
}

function providerRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "aimlapi",
    kind: "aimlapi",
    isActiveText: true,
    isActiveEmbedding: false,
    hasApiKey: true,
    baseUrl: null,
    subscriptionCli: null,
    chatModel: "openai/gpt-5.5-2026-04-23",
    embeddingModel: null,
    ...overrides,
  };
}

function stateWith(
  contextUsage: ContextUsageState,
  extra: Partial<TuiState> = {},
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return { ...base, contextUsage, ...extra };
}

function withRow(contextUsage: ContextUsageState, row: ProviderRow): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    contextUsage,
    providersPanel: { ...base.providersPanel, rows: [row] },
  };
}

describe("selectContextUsage", () => {
  /**
   * Before the first prompt there is no measurement — and `0` would
   * claim the window is empty, which is a stronger statement than "we
   * have not looked yet".
   */
  it("returns nothing before a prompt has been built", () => {
    expect(selectContextUsage(createInitialTuiState(fakeSession()))).toBeNull();
  });

  it("gauges the transcript against the cap it is packed to", () => {
    const view = selectContextUsage(stateWith(usage()));
    expect(view?.conversationTokens).toBe(6400);
    expect(view?.conversationCap).toBe(32_000);
    expect(view?.conversationPercent).toBe(20);
  });

  /**
   * The whole point of gauging the transcript rather than the window:
   * this is the case that used to render no bar at all, on a model whose
   * window nobody has published.
   */
  it("still gauges when the window is unknown", () => {
    const view = selectContextUsage(stateWith(usage({ contextWindow: null })));
    expect(view?.contextWindow).toBeNull();
    expect(view?.percent).toBeNull();
    expect(view?.conversationPercent).toBe(20);
  });

  it("clamps a transcript that overshot its cap", () => {
    const view = selectContextUsage(
      stateWith(usage({ conversationTokens: 33_000, droppedTurns: 4 })),
    );
    expect(view?.conversationPercent).toBe(100);
    expect(view?.droppedTurns).toBe(4);
  });
});

describe("which limit holds the transcript down", () => {
  it("names config when the configured cap is what binds", () => {
    expect(selectContextUsage(stateWith(usage()))?.capSource).toBe("config");
  });

  it("names the window when the clamp cut the configured cap down", () => {
    const view = selectContextUsage(
      stateWith(
        usage({ conversationCap: 9000, conversationCapConfigured: 32_000 }),
      ),
    );
    expect(view?.capSource).toBe("window");
  });

  /**
   * `computeEffectiveConversationCap` floors at 512, which means the
   * window cannot hold the agent's own prompt with room to answer. That
   * is a different problem from a small budget and reads differently.
   */
  it("calls out the floor rather than reporting it as a budget", () => {
    const view = selectContextUsage(
      stateWith(
        usage({ conversationCap: 512, conversationCapConfigured: 32_000 }),
      ),
    );
    expect(view?.capSource).toBe("floor");
  });
});

describe("resolving the model's context window", () => {
  it("prefers the window the prompt was actually built against", () => {
    const view = selectContextUsage(
      stateWith(usage({ contextWindow: 131_072 })),
    );
    expect(view?.contextWindow).toBe(131_072);
    expect(view?.percent).toBe(11);
  });

  /**
   * `localModels.mode: "managed"` defers the boot probe, so a local turn
   * can build its prompt with no window while the health poller — which
   * hits the same `/props` endpoint on its own schedule — already has
   * one.
   */
  it("falls back to the health poller when the prompt has none", () => {
    const base = createInitialTuiState(fakeSession());
    const view = selectContextUsage({
      ...base,
      contextUsage: usage({ contextWindow: null }),
      llmHealth: { ...base.llmHealth, contextWindow: 32_768 },
    });
    expect(view?.contextWindow).toBe(32_768);
  });

  it("falls back to the active provider's catalogue on a cloud turn", () => {
    const view = selectContextUsage(withRow(usage(), providerRow()));
    // `openai/gpt-5.5-2026-04-23`, from the bundled aimlapi catalogue.
    expect(view?.contextWindow).toBe(1_050_000);
  });

  it("reports no window for a provider kind that ships no catalogue", () => {
    const view = selectContextUsage(
      withRow(
        usage(),
        providerRow({ kind: "openai-compatible", chatModel: "some/model" }),
      ),
    );
    expect(view?.contextWindow).toBeNull();
    expect(view?.percent).toBeNull();
  });

  /**
   * `resolveModel` answers with a nominal 128k for anything it does not
   * know. Rendering that as a percentage would be a fabrication, so an
   * uncatalogued id has to come back `null` rather than plausible.
   */
  it("does not fall back to a nominal default for an unknown id", () => {
    const view = selectContextUsage(
      withRow(usage(), providerRow({ chatModel: "vendor/never-heard-of-it" })),
    );
    expect(view?.contextWindow).toBeNull();
  });
});

/**
 * The regression this whole chain exists for: a model added to the
 * provider *after* the bundled snapshot was cut. `alibaba/qwen3.7-plus`
 * is not in `AIMLAPI_MODELS_CATALOG`, so a static-only lookup reports no
 * window and the chip loses its window figure — which is exactly what
 * shipped before this test. The live catalogue the TUI already fetches
 * at start-up knows it.
 */
describe("a model the bundled catalogue has never heard of", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("resolves its window from the live catalogue", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: "alibaba/qwen3.7-plus",
              type: "openai/chat-completions",
              info: { contextLength: 1_000_000 },
            },
          ],
        }),
      })),
    );
    const fetcher = await import(
      "../llm/provider/aimlapi/fetch-aimlapi-chat-catalog.js"
    );
    expect(await fetcher.refreshAimlapiChatCatalogFromApi()).toBe(true);

    const selector = await import("./select-context-usage.js");
    const state = withRow(
      usage(),
      providerRow({ chatModel: "alibaba/qwen3.7-plus" }),
    );
    expect(selector.selectContextUsage(state)?.contextWindow).toBe(1_000_000);
  });
});
