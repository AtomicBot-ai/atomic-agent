import { describe, expect, it } from "vitest";
import type { LocalModelDef, EmbeddingModelDef } from "../../local-llm/index.js";
import { createInitialTuiState } from "../tui-state.js";
import { fakeSession } from "../test-fixtures.js";
import {
  selectLlmActiveRouteSummary,
  selectLlmPanelRows,
  selectPromptLlmMeta,
} from "./llm-panel-selectors.js";

describe("llm-panel selectors", () => {
  it("renders local and cloud mode rows separately", () => {
    const state = {
      ...createInitialTuiState(fakeSession()),
      providersPanel: {
        ...createInitialTuiState(fakeSession()).providersPanel,
        rows: [
          {
            id: "local-llama",
            kind: "llama-server",
            isActiveText: false,
            isActiveEmbedding: false,
            hasApiKey: false,
            chatModel: null,
            embeddingModel: null,
          },
          {
            id: "openrouter",
            kind: "openrouter",
            isActiveText: true,
            isActiveEmbedding: true,
            hasApiKey: true,
            chatModel: "qwen/qwen3.7-max",
            chatModelOptions: ["qwen/qwen3.7-max"],
            embeddingModel: "openai/text-embedding-3-small",
          },
        ],
      },
      localModelsPanel: {
        ...createInitialTuiState(fakeSession()).localModelsPanel,
        daemon: {
          running: true,
          healthy: true,
          loading: false,
          pid: 123,
          port: 19091,
        },
        rows: [
          {
            id: "qwen-3.5-4b",
            def: localDef("qwen-3.5-4b"),
            downloaded: true,
            active: true,
            mmprojStatus: "n/a" as const,
          },
        ],
        embeddingRows: [
          {
            id: "nomic-embed-text-v1.5",
            def: embeddingDef("nomic-embed-text-v1.5"),
            downloaded: true,
            active: true,
          },
        ],
      },
    };

    expect(selectLlmPanelRows(state, "local").map((row) => row.kind)).toEqual([
      "localTextModel",
      "localEmbeddingModel",
    ]);
    const cloudRows = selectLlmPanelRows(state, "cloud");
    expect(cloudRows.map((row) => row.kind)).toContain("cloudProvider");
    expect(cloudRows).toContainEqual(
      expect.objectContaining({
        kind: "cloudChatModel",
        providerId: "openrouter",
        modelId: "qwen/qwen3.7-max",
        active: true,
        // Price comes from the bundled catalog, refreshed from the live
        // OpenRouter list on 2026-08-19 ($1.475/$4.425 per 1M, shown to
        // two decimals).
        enterEffect: expect.stringContaining("$1.48/$4.42"),
      }),
    );
    const activeCloud = cloudRows.find(
      (row) => row.kind === "cloudChatModel" && row.modelId === "qwen/qwen3.7-max",
    );
    expect(activeCloud?.enterEffect).toContain("1M");
    expect(activeCloud?.enterEffect).toContain("text");
    expect(activeCloud?.enterEffect).not.toContain("Enter: use openrouter/");
    expect(selectLlmPanelRows(state, "local")).toContainEqual(
      expect.objectContaining({
        kind: "localTextModel",
        available: true,
        enterEffect: "Enter: select model",
      }),
    );
    const route = selectLlmActiveRouteSummary(state);
    expect(route.providerLabel).toBe("openrouter");
    expect(route.toolTransportLabel).toBe("native_tools");
    expect(route.cacheLabel).toContain("no slot");
    expect(route.usesLocalHealth).toBe(false);
  });

  it("uses cloud provider metadata for the prompt when cloud is active", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      llmHealth: { ...base.llmHealth, status: "healthy" as const, model: "local.gguf" },
      providersPanel: {
        ...base.providersPanel,
        rows: [
          {
            id: "openrouter",
            kind: "openrouter",
            isActiveText: true,
            isActiveEmbedding: false,
            hasApiKey: true,
            chatModel: "openai/gpt-4o-mini",
            embeddingModel: null,
          },
        ],
      },
    };

    expect(selectPromptLlmMeta(state)).toEqual({
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
    });
  });

  it("shows the picked catalog id, not the GGUF name, on managed local", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      // `/props` reports a file name; the catalog id is what the
      // operator picked. Catalog FIRST — deliberately the reverse of
      // the external branch below.
      llmHealth: { ...base.llmHealth, model: "qwen3.5-4b-q4_k_m.gguf" },
      localModelsPanel: {
        ...base.localModelsPanel,
        configMode: "managed" as const,
        activeModelId: "qwen-3.5-4b" as LocalModelDef["id"],
      },
    };
    // No provider word: the second control is the model itself, and the
    // backend word `local` already names the runtime.
    expect(selectPromptLlmMeta(state)).toEqual({
      model: "qwen-3.5-4b",
      provider: null,
    });
  });

  it("falls back to the probe's label while no catalog id is chosen", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      llmHealth: { ...base.llmHealth, model: "something-served.gguf" },
      localModelsPanel: {
        ...base.localModelsPanel,
        configMode: "managed" as const,
        activeModelId: null,
      },
    };
    expect(selectPromptLlmMeta(state)).toEqual({
      model: "something-served.gguf",
      provider: null,
    });
  });

  it("keeps the probe-first label and the llama.cpp word on external", () => {
    const base = createInitialTuiState(fakeSession());
    const state = {
      ...base,
      llmHealth: { ...base.llmHealth, model: "their-server.gguf" },
      localModelsPanel: {
        ...base.localModelsPanel,
        configMode: "external" as const,
        // A leftover managed pick must not shadow what the external
        // server actually reports.
        activeModelId: "qwen-3.5-4b" as LocalModelDef["id"],
      },
    };
    expect(selectPromptLlmMeta(state)).toEqual({
      model: "their-server.gguf",
      provider: "llama.cpp",
    });
  });
});

function localDef(id: LocalModelDef["id"]): LocalModelDef {
  return {
    id,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "u",
    fileSizeGb: 1,
    sizeLabel: "1 GB",
    description: "",
    maxContextLength: 4096,
    contextLabel: "4k",
    minRamGb: 1,
    recommendedRamGb: 2,
    family: "qwen",
    supportsVision: false,
  };
}

function embeddingDef(id: EmbeddingModelDef["id"]): EmbeddingModelDef {
  return {
    id,
    name: id,
    filename: `${id}.gguf`,
    huggingFaceUrl: "u",
    fileSizeGb: 0.1,
    sizeLabel: "100 MB",
    description: "",
    dim: 768,
    pooling: "mean",
    minRamGb: 1,
    recommendedRamGb: 1,
  };
}

describe("local model rows during a pull", () => {
  function stateWithPull(pull: unknown, downloaded: boolean) {
    const base = createInitialTuiState(fakeSession());
    return {
      ...base,
      providersPanel: {
        ...base.providersPanel,
        rows: [
          {
            id: "local-llama",
            kind: "llama-server" as const,
            isActiveText: false,
            isActiveEmbedding: false,
            hasApiKey: false,
            chatModel: null,
            embeddingModel: null,
          },
        ],
      },
      localModelsPanel: {
        ...base.localModelsPanel,
        pull: pull as never,
        rows: [
          {
            id: "qwen-3.5-4b" as const,
            def: localDef("qwen-3.5-4b"),
            downloaded,
            active: false,
            mmprojStatus: "n/a" as const,
          },
        ],
      },
    };
  }

  const pullFor = (percent: number) => ({
    kind: "chat" as const,
    modelId: "qwen-3.5-4b" as const,
    label: "qwen-3.5-4b",
    percent,
    transferredBytes: 1_000,
    totalBytes: 100_000,
    error: null,
  });

  it("says the model is downloading instead of offering the download again", () => {
    const rows = selectLlmPanelRows(stateWithPull(pullFor(42), false), "local");
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "localTextModel",
        primaryAction: "downloading",
        enterEffect: "Downloading… 42%",
        available: false,
      }),
    );
  });

  it("offers selection once the pull is finished", () => {
    const rows = selectLlmPanelRows(stateWithPull(null, true), "local");
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "localTextModel",
        primaryAction: "use",
        enterEffect: "Enter: select model",
        available: true,
      }),
    );
  });

  it("falls back to the download hint when a pull failed", () => {
    const failed = { ...pullFor(7), error: "connection reset" };
    const rows = selectLlmPanelRows(stateWithPull(failed, false), "local");
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "localTextModel",
        primaryAction: "download",
        enterEffect: "Enter: download",
      }),
    );
  });

  it("does not claim a different model is downloading", () => {
    const other = { ...pullFor(50), modelId: "gemma-4-12b" as never };
    const rows = selectLlmPanelRows(stateWithPull(other, false), "local");
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "localTextModel",
        primaryAction: "download",
      }),
    );
  });
});

