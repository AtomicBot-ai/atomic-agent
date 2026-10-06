import type { UserLocalModelsConfig } from "./local-models-types.js";
import { DEFAULT_DOWNLOAD_CONNECTIONS } from "../../local-llm/downloads/download-settings.js";
import { DEFAULT_HF_ENDPOINT } from "../../local-llm/catalog/huggingface-endpoint.js";

export function createLocalModelsDefaults(): UserLocalModelsConfig {
  return {
    url: "http://127.0.0.1:8080",
    mode: "external",
    completionMaxTokens: 16384,
    useServerTemplate: "auto",
    thinking: "auto",
    reasoningBudgetTokens: 1500,
    managed: {
      modelId: null,
      port: 19091,
      dataDirOverride: null,
      autoUpdate: true,
      stopOnExit: true,
      autoRestart: true,
      device: "auto",
      backendVariant: "auto",
      contextSize: 0,
      tensorSplit: [],
      parallel: "auto",
      swaFull: "auto",
    },
    embeddings: {
      enabled: false,
      modelId: null,
      port: 19092,
      url: "http://127.0.0.1:19092",
    },
    download: {
      connections: DEFAULT_DOWNLOAD_CONNECTIONS,
      hfEndpoint: DEFAULT_HF_ENDPOINT,
    },
    customModels: [],
  };
}
