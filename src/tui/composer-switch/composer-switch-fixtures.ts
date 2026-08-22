import type { LocalModelDef } from "../../local-llm/index.js";
import type { ProviderRow } from "../providers/providers-panel-state.js";
import { fakeSession } from "../test-fixtures.js";
import { createInitialTuiState, type TuiState } from "../tui-state.js";

/**
 * States for the composer-switch tests. Shared rather than repeated per
 * file because every case here is "the same app with a different route
 * configured", and the interesting part of each test is the assertion,
 * not the forty lines of panel state that set it up.
 */
export function providerRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: "openrouter",
    kind: "openrouter",
    isActiveText: false,
    isActiveEmbedding: false,
    hasApiKey: true,
    baseUrl: null,
    subscriptionCli: null,
    chatModel: "qwen/qwen3.7-max",
    chatModelOptions: ["qwen/qwen3.7-max"],
    embeddingModel: null,
    ...overrides,
  };
}

export function localModelDef(id: string): LocalModelDef {
  return {
    id: id as LocalModelDef["id"],
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

/** A cloud route: one provider with a key, active, one model pinned. */
export function cloudState(overrides: Partial<ProviderRow> = {}): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    providersPanel: {
      ...base.providersPanel,
      rows: [
        providerRow({ id: "local-llama", kind: "llama-server", hasApiKey: false, chatModel: null, chatModelOptions: [] }),
        providerRow({ isActiveText: true, ...overrides }),
        providerRow({ id: "aimlapi", kind: "aimlapi", hasApiKey: false, chatModel: null, chatModelOptions: [] }),
      ],
    },
  };
}

/** A managed-local route with one downloaded model and a live daemon. */
export function localState(configMode: "managed" | "external" = "managed"): TuiState {
  const base = createInitialTuiState(fakeSession());
  return {
    ...base,
    providersPanel: {
      ...base.providersPanel,
      rows: [
        providerRow({
          id: "local-llama",
          kind: "llama-server",
          isActiveText: true,
          hasApiKey: false,
          chatModel: null,
          chatModelOptions: [],
        }),
      ],
    },
    localModelsPanel: {
      ...base.localModelsPanel,
      configMode,
      daemon: { running: true, healthy: true, loading: false, pid: 1, port: 19091 },
      rows: [
        {
          id: "qwen-3.5-4b" as LocalModelDef["id"],
          def: localModelDef("qwen-3.5-4b"),
          downloaded: true,
          active: true,
          mmprojStatus: "n/a" as const,
        },
      ],
    },
  };
}
