import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import type { TuiAction } from "../tui-action.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { selectCloudModelSection, selectCloudRows } from "./llm-panel-row-builders.js";
import type { LlmPanelRow } from "./llm-panel-selectors.js";
import { triggerLlmPrimary } from "./llm-panel-primary-actions.js";

/** Prime the module-level `/v1/models` cache exactly like the picker does. */
async function seedCompatCache(
  baseUrl: string,
  ids: readonly string[],
): Promise<void> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    })),
  );
  await fetchOpenAiCompatModels(baseUrl, "key");
  vi.unstubAllGlobals();
}

function compatProvider(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "xai",
    kind: "openai-compatible",
    isActiveText: true,
    isActiveEmbedding: false,
    hasApiKey: true,
    baseUrl: "https://api.x.ai",
    chatModel: "grok-4",
    chatModelOptions: ["grok-4"],
    embeddingModel: null,
    ...overrides,
  };
}

function stateWith(
  rows: readonly ProviderRow[],
  patch: {
    filter?: string;
    inlineModels?: TuiState["providersPanel"]["inlineModels"];
  } = {},
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    providersPanel: {
      ...base.providersPanel,
      rows,
      inlineModels: patch.inlineModels ?? null,
    },
    llmPanel: {
      ...base.llmPanel,
      mode: "cloud",
      cloudModelFilter: patch.filter ?? "",
    },
  };
}

function chatRows(state: TuiState) {
  return selectCloudRows(state).filter(
    (row): row is Extract<LlmPanelRow, { kind: "cloudChatModel" }> =>
      row.kind === "cloudChatModel",
  );
}

function callbacks(overrides: Partial<TuiAppCallbacks> = {}): TuiAppCallbacks {
  return {
    onApprovalDecision: vi.fn(),
    onAbort: vi.fn(),
    onQuit: vi.fn(),
    onMessageSubmitted: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("inline cloud model section from the openai-compat cache", () => {
  it("lists every cached model as its own row, current first", async () => {
    const models = [
      "grok-2",
      "grok-3",
      "grok-3-mini",
      "grok-4",
      "grok-4-fast",
      "grok-code",
    ];
    await seedCompatCache("https://api.x.ai", models);
    const state = stateWith([compatProvider()]);

    const rows = chatRows(state);
    expect(rows).toHaveLength(6);
    // Current model first, marked as such; the rest select directly.
    expect(rows[0]).toMatchObject({
      modelId: "grok-4",
      active: true,
      primaryAction: "current",
      enterEffect: "Current: xai/grok-4",
    });
    expect(rows.map((row) => row.modelId).sort()).toEqual(models.sort());
    expect(
      rows.find((row) => row.modelId === "grok-2"),
    ).toMatchObject({ primaryAction: "use", enterEffect: "Enter: use xai/grok-2" });
    expect(selectCloudModelSection(state).status).toBe("ready");
  });

  it("keeps all 354 models as rows: the renderer windows, the list does not cap", async () => {
    const models = Array.from({ length: 354 }, (_, i) =>
      `m-${String(i).padStart(3, "0")}`,
    );
    await seedCompatCache("https://inference.nous.example", models);
    const state = stateWith([
      compatProvider({
        id: "nous",
        baseUrl: "https://inference.nous.example",
        chatModel: "m-200",
        chatModelOptions: ["m-200"],
      }),
    ]);

    const rows = chatRows(state);
    expect(rows).toHaveLength(354);
    expect(rows[0]).toMatchObject({
      modelId: "m-200",
      active: true,
      primaryAction: "current",
    });
    const section = selectCloudModelSection(state);
    expect(section.models).toHaveLength(354);
    expect(section.filtered).toHaveLength(354);
    // Model rows start right after the single provider row.
    expect(section.sectionStart).toBe(1);
  });

  it("filters the rows with the typed query, case-insensitively", async () => {
    await seedCompatCache("https://filter.example", [
      "grok-4.3",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
      "other-model",
    ]);
    const state = stateWith(
      [
        compatProvider({
          baseUrl: "https://filter.example",
          chatModel: "grok-4.3",
          chatModelOptions: ["grok-4.3"],
        }),
      ],
      { filter: "REASONING" },
    );

    const rows = chatRows(state);
    expect(rows.map((row) => row.modelId)).toEqual([
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-0309-reasoning",
    ]);
    const section = selectCloudModelSection(state);
    expect(section.models).toHaveLength(4);
    expect(section.filtered).toHaveLength(2);
  });

  it("reports loading with a single current-model fallback row while the cache is cold", () => {
    const state = stateWith([
      compatProvider({ baseUrl: "https://cold.example", chatModel: "grok-4" }),
    ]);

    const rows = chatRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: "grok-4", primaryAction: "current" });
    expect(selectCloudModelSection(state).status).toBe("loading");
  });

  it("prefers the live inline catalog state over the module cache", () => {
    const state = stateWith(
      [compatProvider({ baseUrl: "https://live.example" })],
      {
        inlineModels: {
          providerId: "xai",
          status: "ready",
          models: ["live-a", "live-b"],
          error: null,
          generation: 1,
        },
      },
    );
    const rows = chatRows(state);
    expect(rows.map((row) => row.modelId)).toEqual(["grok-4", "live-a", "live-b"]);
  });

  it("falls back to one current-model row and surfaces the message on fetch error", () => {
    const state = stateWith(
      [compatProvider({ baseUrl: "https://down.example" })],
      {
        inlineModels: {
          providerId: "xai",
          status: "error",
          models: [],
          error: "getaddrinfo ENOTFOUND down.example",
          generation: 1,
        },
      },
    );
    const rows = chatRows(state);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ modelId: "grok-4", primaryAction: "current" });
    const section = selectCloudModelSection(state);
    expect(section.status).toBe("error");
    expect(section.error).toContain("ENOTFOUND");
  });
});

describe("inline cloud model section for curated providers", () => {
  it("lists the full OpenRouter catalog inline, current model first", () => {
    const state = stateWith([
      {
        id: "openrouter",
        kind: "openrouter",
        isActiveText: true,
        isActiveEmbedding: false,
        hasApiKey: true,
        baseUrl: null,
        chatModel: "qwen/qwen3.7-max",
        chatModelOptions: ["qwen/qwen3.7-max"],
        embeddingModel: null,
      },
    ]);

    const rows = chatRows(state);
    // The static catalog alone lists 18 chat models; all become rows.
    expect(rows.length).toBeGreaterThan(12);
    expect(rows[0]).toMatchObject({
      modelId: "qwen/qwen3.7-max",
      active: true,
    });
    expect(selectCloudModelSection(state).status).toBe("ready");
  });
});

describe("Enter on a model row", () => {
  it("selects the model directly through onProvidersSelectChatModel", async () => {
    await seedCompatCache("https://select.example", ["alpha", "beta", "gamma"]);
    const state = stateWith([
      compatProvider({
        id: "xai",
        baseUrl: "https://select.example",
        chatModel: "alpha",
        chatModelOptions: ["alpha"],
      }),
    ]);
    const row = chatRows(state).find((r) => r.modelId === "beta");
    expect(row).toBeDefined();

    const dispatched: TuiAction[] = [];
    const onProvidersSelectChatModel = vi.fn();
    triggerLlmPrimary(
      row!,
      state,
      (action) => dispatched.push(action),
      callbacks({ onProvidersSelectChatModel }),
    );
    expect(onProvidersSelectChatModel).toHaveBeenCalledWith("xai", "beta");
    expect(dispatched).toEqual([]);
  });
});
