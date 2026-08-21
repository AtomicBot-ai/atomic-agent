import { describe, expect, it } from "vitest";
import { selectContextUsage } from "./select-context-usage.js";
import type { ProviderRow } from "./providers/providers-panel-state.js";
import {
  createInitialTuiState,
  type TuiSessionInfo,
  type TuiState,
} from "./tui-state.js";

function fakeSession(): TuiSessionInfo {
  return {
    sessionId: null,
    workingDir: "/tmp",
    llamaUrl: "http://127.0.0.1:8080",
    browserChannel: "chrome",
    browserHeadless: false,
    approvalLevel: 5,
    maxSteps: 10,
    completionMaxTokens: 2048,
    skillCount: 0,
    localBackendConfigured: false,
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
    contextWindow: 200_000,
    ...overrides,
  };
}

function stateWith(overrides: Partial<TuiState>): TuiState {
  return { ...createInitialTuiState(fakeSession()), ...overrides };
}

describe("selectContextUsage", () => {
  /**
   * Before the first prompt there is no measurement — and `0%` would
   * claim the window is empty, which is a stronger statement than "we
   * have not looked yet".
   */
  it("returns nothing before a prompt has been built", () => {
    expect(selectContextUsage(createInitialTuiState(fakeSession()))).toBeNull();
  });

  it("divides by the window the prompt itself was built against", () => {
    const view = selectContextUsage(
      stateWith({
        contextUsage: {
          tokens: 32_768,
          contextWindow: 131_072,
          droppedTurns: 0,
          sections: [],
        },
      }),
    );
    expect(view?.percent).toBe(25);
    expect(view?.contextWindow).toBe(131_072);
    expect(view?.droppedTurns).toBe(0);
  });

  /**
   * Cloud turns build with no window (the runtime only learns one from
   * the llama-server probe), so the active provider row's catalogue
   * lookup is the fallback.
   */
  it("falls back to the active provider's window on a cloud turn", () => {
    const base = createInitialTuiState(fakeSession());
    const view = selectContextUsage({
      ...base,
      contextUsage: {
        tokens: 20_000,
        contextWindow: null,
        droppedTurns: 0,
        sections: [],
      },
      providersPanel: { ...base.providersPanel, rows: [providerRow()] },
    });
    expect(view?.contextWindow).toBe(200_000);
    expect(view?.percent).toBe(10);
  });

  it("reports no percentage when nobody knows the window", () => {
    const base = createInitialTuiState(fakeSession());
    const view = selectContextUsage({
      ...base,
      contextUsage: {
        tokens: 20_000,
        contextWindow: null,
        droppedTurns: 0,
        sections: [],
      },
      providersPanel: {
        ...base.providersPanel,
        rows: [providerRow({ contextWindow: null })],
      },
    });
    expect(view?.contextWindow).toBeNull();
    expect(view?.percent).toBeNull();
    expect(view?.tokens).toBe(20_000);
  });

  /**
   * The estimator over-counts by design, so a prompt can measure larger
   * than the window it fit into. A gauge past 100% would read as a bug.
   */
  it("clamps an over-count to 100%", () => {
    const view = selectContextUsage(
      stateWith({
        contextUsage: {
          tokens: 140_000,
          contextWindow: 131_072,
          droppedTurns: 4,
          sections: [],
        },
      }),
    );
    expect(view?.percent).toBe(100);
    expect(view?.droppedTurns).toBe(4);
  });
});
