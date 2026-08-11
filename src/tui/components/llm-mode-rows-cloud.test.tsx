import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenAiCompatModels } from "../../llm/provider/openai/fetch-openai-compat-models.js";
import { selectLlmPanelRows } from "../llm-panel/llm-panel-selectors.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";
import { LlmModeRows } from "./llm-mode-rows.js";

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
    id: "nous",
    kind: "openai-compatible",
    isActiveText: true,
    isActiveEmbedding: false,
    hasApiKey: true,
    baseUrl: "https://render.nous.example",
    chatModel: "m-000",
    chatModelOptions: ["m-000"],
    embeddingModel: null,
    ...overrides,
  };
}

function cloudState(
  rows: readonly ProviderRow[],
  patch: Partial<TuiState["llmPanel"]> = {},
  inlineModels: TuiState["providersPanel"]["inlineModels"] = null,
): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    providersPanel: { ...base.providersPanel, rows, inlineModels },
    llmPanel: { ...base.llmPanel, mode: "cloud", ...patch },
  };
}

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

function renderRows(state: TuiState, maxRows: number): string {
  const rows = selectLlmPanelRows(state);
  const { lastFrame, unmount } = render(
    <LlmModeRows rows={rows} state={state} maxRows={maxRows} />,
  );
  const frame = strip(lastFrame() ?? "");
  unmount();
  return frame;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CloudRows inline model section", () => {
  it("renders the two-line header (provider:/filter:) between providers and embeddings", async () => {
    await seedCompatCache("https://render.nous.example", ["m-000", "m-001"]);
    const frame = renderRows(cloudState([compatProvider()]), 30);
    const lines = frame.split("\n").map((line) => line.trimEnd());
    const providersIdx = lines.findIndex((l) => l.includes("Cloud providers"));
    const headerIdx = lines.findIndex((l) => l.includes("Cloud text models"));
    const providerLineIdx = lines.findIndex((l) => l.startsWith("provider: nous"));
    const filterLineIdx = lines.findIndex((l) => l.startsWith("filter:"));
    const embeddingsIdx = lines.findIndex((l) => l.includes("Cloud embeddings"));
    expect(providersIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeGreaterThan(providersIdx);
    expect(providerLineIdx).toBe(headerIdx + 1);
    expect(filterLineIdx).toBe(headerIdx + 2);
    expect(embeddingsIdx).toBeGreaterThan(filterLineIdx);
  });

  it("windows 354 models to exactly 12 visible rows with the (n/N) counter", async () => {
    const models = Array.from({ length: 354 }, (_, i) =>
      `m-${String(i).padStart(3, "0")}`,
    );
    await seedCompatCache("https://render354.nous.example", models);
    const state = cloudState([
      compatProvider({ baseUrl: "https://render354.nous.example" }),
    ]);
    const frame = renderRows(state, 40);
    const modelLines = frame
      .split("\n")
      .filter((line) => line.includes("nous/m-") && line.includes("[text]"));
    expect(modelLines).toHaveLength(12);
    expect(frame).toContain("(1/354)");
  });

  it("marks the current model and shows the filtered counter", async () => {
    await seedCompatCache("https://renderfilter.nous.example", [
      "m-000",
      "m-001",
      "x-002",
    ]);
    const state = cloudState(
      [compatProvider({ baseUrl: "https://renderfilter.nous.example" })],
      { cloudModelFilter: "m-0", cloudModelFilterFocused: true, cloudCursor: 1 },
    );
    const frame = renderRows(state, 30);
    expect(frame).toContain("filter: m-0");
    expect(frame).toContain("type to filter");
    // Current model row keeps its active mark and Current wording.
    expect(frame).toContain("* nous/m-000 [text]");
    expect(frame).toContain("Current: nous/m-000");
    // x-002 is filtered out; counter reports filtered of total.
    expect(frame).not.toContain("x-002");
    expect(frame).toContain("(1/2 of 3)");
  });

  it("shows the loading line while the catalog fetch is in flight", () => {
    const state = cloudState(
      [compatProvider({ baseUrl: "https://renderload.nous.example" })],
      {},
      {
        providerId: "nous",
        status: "loading",
        models: [],
        error: null,
        generation: 1,
      },
    );
    const frame = renderRows(state, 30);
    expect(frame).toContain("fetching model list…");
    // Fallback current-model row stays selectable under the loading line.
    expect(frame).toContain("nous/m-000 [text]");
  });

  it("shows the error line and the one-row current-model fallback on fetch failure", () => {
    const state = cloudState(
      [compatProvider({ baseUrl: "https://rendererr.nous.example" })],
      {},
      {
        providerId: "nous",
        status: "error",
        models: [],
        error: "getaddrinfo ENOTFOUND rendererr.nous.example",
        generation: 1,
      },
    );
    const frame = renderRows(state, 30);
    expect(frame).toContain("model list unavailable");
    expect(frame).toContain("ENOTFOUND");
    expect(frame).toContain("showing current model only");
    expect(frame).toContain("nous/m-000 [text]");
  });
});
